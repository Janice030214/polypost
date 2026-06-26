// 复用 Strapi 后台的 "Translate with AI"（插件 strapi-ai-translator）
// 流程：admin 登录拿 JWT → POST /strapi-ai-translator/translate（SSE 流）→ 汇总译文
//
// 401 自动重登：缓存的 JWT 过期后自动刷新一次并重试。

const URLBASE = () => (process.env.STRAPI_URL || '').replace(/\/$/, '');

export const LOCALES = {
  en: 'English', zh: '简体中文', 'zh-Hant': '繁體中文', ja: '日本語', ko: '한국어',
  de: 'Deutsch', fr: 'Français', es: 'Español', ru: 'Русский', ar: 'العربية',
};

let adminToken = null;
let schemaCache = null;

export async function adminLogin(forceRefresh = false) {
  if (adminToken && !forceRefresh) return adminToken;
  const email = process.env.STRAPI_ADMIN_EMAIL;
  const password = process.env.STRAPI_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('admin 登录所需信息缺失：请在 .env 填 STRAPI_ADMIN_EMAIL / STRAPI_ADMIN_PASSWORD');
  }
  const res = await fetch(`${URLBASE()}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok || !json.data?.token) {
    throw new Error(`admin 登录失败 HTTP ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 200)}`);
  }
  adminToken = json.data.token;
  schemaCache = null; // 新 token 后 schema 缓存也重置（避免和旧 token 状态混淆）
  return adminToken;
}

// 把 admin token 失效（用于 401 后强制下一次重登）
export function invalidateAdminToken() {
  adminToken = null;
  schemaCache = null;
}

// 用 admin JWT 跑一个回调；如果回调因 401 抛错，重登一次再跑一次。
// 回调可以传 throw 一个带 .status===401 的 Error，或抛 Error 含 "401" 字样，都会触发重试。
export async function withAdminAuthRetry(fn) {
  let token = await adminLogin();
  try {
    return await fn(token);
  } catch (e) {
    const looks401 = e?.status === 401 || /HTTP\s*401|Unauthorized|Missing or invalid credentials/i.test(e?.message || '');
    if (!looks401) throw e;
    invalidateAdminToken();
    token = await adminLogin(true);
    return await fn(token);
  }
}

// 拉取 blog 内容类型 schema 与全部 components（插件需要据此判断可翻译字段）
async function getSchema(token) {
  if (schemaCache) return schemaCache;
  const h = { Authorization: `Bearer ${token}` };
  const ctRes = await fetch(`${URLBASE()}/content-manager/content-types`, { headers: h });
  if (ctRes.status === 401) {
    const err = new Error('admin token expired (401) at content-types');
    err.status = 401; throw err;
  }
  const ctJson = await ctRes.json();
  const contentType = (ctJson.data || []).find((c) => c.uid === 'api::blog.blog');
  if (!contentType) throw new Error('未找到 api::blog.blog 内容类型 schema');

  const cmpRes = await fetch(`${URLBASE()}/content-manager/components`, { headers: h });
  if (cmpRes.status === 401) {
    const err = new Error('admin token expired (401) at components');
    err.status = 401; throw err;
  }
  const cmpJson = await cmpRes.json();
  schemaCache = { contentType, components: cmpJson.data || [] };
  return schemaCache;
}

// 解析 SSE 流，返回合并后的译文对象 { field: value }
async function parseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let data = '';
  const result = {};

  function handle(evt) {
    if (evt.type === 'error') throw new Error(evt.message || 'Translation failed');
    if ((evt.type === 'batch_complete' || evt.type === 'done') && evt.data) {
      Object.assign(result, evt.data);
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ')) data = line.slice(6);
      else if (line === '' && data) {
        try { handle(JSON.parse(data)); } catch { /* 忽略半包 */ }
        data = '';
      }
    }
  }
  return result;
}

// 保护不可翻译的内嵌标签（如 <youtube>VIDEO_ID</youtube>）：
// 翻译前替换成不可读的占位符，翻译完再换回来——
// 这样无论 LLM 怎么"理解"原文，标签里的 ID 都不会被改、被翻译、被删。
function protectInlineTags(text) {
  const tokens = [];
  const replaced = String(text || '').replace(
    /<youtube>\s*([^<\s]+?)\s*<\/youtube>/gi,
    (_, id) => {
      tokens.push(id);
      // 占位符用一种 LLM 不会翻译的形态
      return `​__YT${tokens.length - 1}__​`;
    }
  );
  return { replaced, tokens };
}
function restoreInlineTags(text, tokens) {
  if (!tokens.length) return text;
  return String(text || '').replace(/​__YT(\d+)__​/g, (m, i) => {
    const id = tokens[+i];
    return id !== undefined ? `<youtube>${id}</youtube>` : m;
  });
}

export async function translateFields(fields, targetLocale, onProgress = () => {}) {
  const name = LOCALES[targetLocale] || targetLocale;
  // 把 <youtube>ID</youtube> 替换成占位符，确保翻译过程不动它
  const contentProtected = protectInlineTags(fields.content);
  const source = {
    title: fields.title,
    description: fields.description,
    content: contentProtected.replaced,
  };
  if (fields.metaTitle) source.metaTitle = fields.metaTitle;

  onProgress(`Strapi 翻译为 ${name}…`);

  const doCall = async (token) => {
    const { contentType, components } = await getSchema(token);
    const res = await fetch(`${URLBASE()}/strapi-ai-translator/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ contentType, fields: source, components, targetLanguage: targetLocale }),
    });
    if (res.status === 401) {
      const err = new Error('admin token expired (401) at translate');
      err.status = 401; throw err;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`翻译接口 HTTP ${res.status}: ${t.slice(0, 300)}`);
    }
    return await parseStream(res);
  };

  const translated = await withAdminAuthRetry(doCall);
  if (!Object.keys(translated).length) throw new Error('翻译返回为空');

  // 翻译结果里把占位符换回 <youtube>ID</youtube>
  const translatedContent = restoreInlineTags(
    translated.content ?? fields.content,
    contentProtected.tokens
  );

  return {
    ...fields,
    title: translated.title ?? fields.title,
    description: translated.description ?? fields.description,
    content: translatedContent,
    metaTitle: translated.metaTitle ?? fields.metaTitle,
    locale: targetLocale,
  };
}
