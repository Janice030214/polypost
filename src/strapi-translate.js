// 复用 Strapi 后台的 "Translate with AI"（插件 @strapi-ai/translator，注册名 ai-translator）
// 流程：admin 登录拿 JWT → POST /ai-translator/translate（SSE 事件流）→ 应用 patch 得到译文
//
// ⚠️ 2026-07-20 后台从 5.46.1 升级到 5.50.1，插件从 strapi-ai-translator 换成
//    @strapi-ai/translator，接口完全变了（旧接口 405）。本文件按新契约重写：
//    请求 { contentType, entry, components, sourceLocale, targetLocale }
//    响应 SSE 事件：session_started / unit_completed{path,translatedText}
//               / session_completed{patch.operations} / session_failed
//
// 401 自动重登：缓存的 JWT 过期后自动刷新一次并重试。

const URLBASE = () => (process.env.STRAPI_URL || '').replace(/\/$/, '');

export const LOCALES = {
  en: 'English', zh: '简体中文', 'zh-Hant': '繁體中文', ja: '日本語', ko: '한국어',
  de: 'Deutsch', fr: 'Français', es: 'Español', pt: 'Português', ru: 'Русский', ar: 'العربية',
  hi: 'हिन्दी', it: 'Italiano', nl: 'Nederlands', pl: 'Polski', tr: 'Türkçe',
  vi: 'Tiếng Việt', th: 'ไทย', id: 'Bahasa Indonesia', sv: 'Svenska',
};

let adminToken = null;
let schemaCache = null;
let loginInFlight = null; // 单飞：并发翻译时共用同一个登录请求（/admin/login 有频率限制，各自登录会被限流 500）

async function doLogin() {
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
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.data?.token) {
    throw new Error(`admin 登录失败 HTTP ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 200)}`);
  }
  adminToken = json.data.token;
  schemaCache = null; // 新 token 后 schema 缓存也重置（避免和旧 token 状态混淆）
  return adminToken;
}

export async function adminLogin(forceRefresh = false) {
  if (adminToken && !forceRefresh) return adminToken;
  if (loginInFlight) return loginInFlight; // 已有登录在途（即使是 force，拿到的也是全新 token）
  loginInFlight = doLogin().finally(() => { loginInFlight = null; });
  return loginInFlight;
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

// 按 path 数组往对象里写值（仿 admin 端的 set-by-path；我们的字段是平铺的，
// 但组件/数组字段的 path 形如 ['seo', 0, 'metaTitle']，也一并支持）
function setByPath(obj, path, value) {
  if (!Array.isArray(path) || !path.length) return;
  if (path.some((s) => typeof s === 'string' && ['__proto__', 'constructor', 'prototype'].includes(s))) return;
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = typeof path[i + 1] === 'number' ? [] : {};
    }
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

// 解析新插件的 SSE 事件流，返回合并后的译文对象 { field: value }。
// 事件模型（@strapi-ai/translator）：
//   unit_completed  { path: ['title'], translatedText }   —— 单字段完成
//   session_completed { patch: { operations: [{path, value}] } } —— 最终 patch（权威）
//   session_failed  { error }
// data 可能跨多行（data: 前缀逐行累积，空行为事件边界），照 admin 端实现解析。
async function parseStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines = [];
  const result = {};
  let sessionDone = false;

  function flushEvent() {
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    let evt;
    try { evt = JSON.parse(raw); } catch { return; /* 忽略半包 */ }
    if (!evt || typeof evt !== 'object') return;
    switch (evt.type) {
      case 'unit_completed':
        if (evt.path && evt.translatedText != null) setByPath(result, evt.path, evt.translatedText);
        break;
      case 'session_completed':
        if (evt.patch?.operations) {
          for (const op of evt.patch.operations) setByPath(result, op.path, op.value);
        }
        sessionDone = true;
        break;
      case 'session_failed':
        throw new Error(evt.error || 'Translation failed');
      default: /* session_started / unit_started / unit_delta 等进度事件忽略 */
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      if (buf) {
        const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      flushEvent();
      break;
    }
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      else if (line === '') flushEvent();
    }
  }
  if (!sessionDone && !Object.keys(result).length) return {};
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
  // 零宽空格写成 ​? 可选——新插件（@strapi-ai/translator）会把零宽字符规范化掉，
  // 只剩 __YT0__；两种形态都要能还原
  return String(text || '').replace(/​?__YT(\d+)__​?/g, (m, i) => {
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
    // components 新契约要求对象（uid → schema），/content-manager/components 返回的是数组
    const componentsMap = Array.isArray(components)
      ? Object.fromEntries(components.map((c) => [c.uid, c]))
      : (components || {});
    // 新插件 @strapi-ai/translator：路由 /ai-translator/translate，
    // 请求体 { contentType, entry, components, sourceLocale, targetLocale }
    const res = await fetch(`${URLBASE()}/ai-translator/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        contentType,
        entry: source,
        components: componentsMap,
        sourceLocale: fields.locale || 'en',
        targetLocale,
      }),
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
