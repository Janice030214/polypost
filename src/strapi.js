// Strapi v5 交互：上传图片、创建 blog 文章
const URLBASE = () => (process.env.STRAPI_URL || '').replace(/\/$/, '');
const TOKEN = () => process.env.STRAPI_TOKEN;

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN()}`, ...extra };
}

// 带超时 + 重试的 JSON 请求。网络错误（fetch failed / 连接重置 / 超时）和 5xx 都会重试。
// 网络本身抖动时（Strapi 偶发连不上），单次失败不再直接把整个同步/发布搞崩。
// 返回 { ok, status, json }；彻底失败（多次网络错误）抛出带中文说明的错误。
async function jsonFetchRetry(url, { method, body, tries = 3, timeoutMs = 45000 } = {}) {
  let lastNetErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
      // 5xx 视为可重试；4xx 是业务错误，直接返回让调用方处理
      if (!res.ok && res.status >= 500 && attempt < tries) {
        await new Promise((s) => setTimeout(s, 600 * attempt));
        continue;
      }
      return { ok: res.ok, status: res.status, json };
    } catch (e) {
      clearTimeout(timer);
      lastNetErr = e;
      // 网络类错误（含超时 abort）→ 退避后重试
      if (attempt < tries) { await new Promise((s) => setTimeout(s, 700 * attempt)); continue; }
    }
  }
  const hint = lastNetErr?.name === 'AbortError' ? '请求超时' : (lastNetErr?.message || 'fetch failed');
  const err = new Error(`连接 Strapi 失败（网络波动？已重试 ${tries} 次）：${hint}`);
  err.networkError = true;
  throw err;
}

// 上传一个二进制文件到 Strapi media 库，返回 { id, url }。500/网络错误时自动重试一次。
export async function uploadFile({ buffer, mime, name }) {
  const sizeKB = Math.round(buffer.length / 1024);
  const tryOnce = async () => {
    const form = new FormData();
    const blob = new Blob([buffer], { type: mime });
    form.append('files', blob, name);
    const res = await fetch(`${URLBASE()}/api/upload`, {
      method: 'POST',
      headers: authHeaders(), // 不要手动设 Content-Type，让 fetch 自带 boundary
      body: form,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, json };
  };

  let r;
  try { r = await tryOnce(); }
  catch (e) { r = { ok: false, status: 0, json: { error: { message: e.message } } }; }
  if (!r.ok && (r.status === 0 || r.status >= 500)) {
    await new Promise((s) => setTimeout(s, 800));
    try { r = await tryOnce(); }
    catch (e) { r = { ok: false, status: 0, json: { error: { message: e.message } } }; }
  }
  if (!r.ok) {
    const detail = r.json?.error?.message || JSON.stringify(r.json).slice(0, 200);
    throw new Error(`上传 "${name}" (${sizeKB}KB ${mime}) 失败 HTTP ${r.status}: ${detail}`);
  }
  const file = Array.isArray(r.json) ? r.json[0] : r.json;
  return { id: file.id, url: file.url };
}

// Strapi 里这几个是单行字符串字段（DB VARCHAR，上限 255）；超长会让数据库报错、
// Strapi 直接回 500「Internal Server Error」（看不出是长度问题）。写入前先拦下来给清晰提示。
// title/slug/author 实测 255 上限；metaTitle/description/content 是长文本，不限。
const STRING_LIMIT = 255;
const LIMITED_FIELDS = ['title', 'slug', 'author'];
function assertFieldLimits(fields) {
  const over = LIMITED_FIELDS
    .filter((k) => typeof fields[k] === 'string' && fields[k].length > STRING_LIMIT)
    .map((k) => `${k}（${fields[k].length} 字）`);
  if (over.length) {
    const loc = fields.locale ? `[${fields.locale}] ` : '';
    throw new Error(
      `${loc}字段超长，Strapi 上限 ${STRING_LIMIT} 字：${over.join('、')}。` +
      `请把对应字段改短——标题过长通常是正文里的长标题/长句被误当成了 title，可在上方「标题」框手动填一个简短标题。`
    );
  }
}

// 创建一篇 blog（默认草稿）。fields 直接对应 Strapi blog 字段
export async function createBlog(fields, { publish = false } = {}) {
  assertFieldLimits(fields);
  const qs = publish ? '?status=published' : '?status=draft';
  const { ok, status, json } = await jsonFetchRetry(`${URLBASE()}/api/blogs${qs}`, {
    method: 'POST',
    body: JSON.stringify({ data: fields }),
  });
  if (!ok) {
    throw new Error(`创建文章失败 HTTP ${status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

// 给已存在的文档(documentId)新增/更新一个语言版本（Strapi v5 i18n）
export async function createLocalization(documentId, fields, { publish = false } = {}) {
  assertFieldLimits(fields);
  const s = publish ? 'published' : 'draft';
  const url = `${URLBASE()}/api/blogs/${documentId}?locale=${encodeURIComponent(fields.locale)}&status=${s}`;
  const { ok, status, json } = await jsonFetchRetry(url, {
    method: 'PUT',
    body: JSON.stringify({ data: fields }),
  });
  if (!ok) {
    throw new Error(`创建 ${fields.locale} 版本失败 HTTP ${status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

// 发布某个 locale 的草稿。
// 主路径：内容 API token（Full access）PUT ?status=published —— 直接把该 locale 的草稿
//   提升为已发布。相比后台 content-manager 的 Publish 动作，这个不受 admin 角色的
//   「按 locale 授权」限制（后台账号是 Editor，对新加的语种没有发布权限 → 403）。
//   空 {data:{}} 是部分更新，只翻转 publishedAt，不动已有字段。
export async function publishLocale(documentId, locale, _adminJwt) {
  const url = `${URLBASE()}/api/blogs/${documentId}?locale=${encodeURIComponent(locale)}&status=published`;
  const { ok, status, json } = await jsonFetchRetry(url, {
    method: 'PUT',
    body: JSON.stringify({ data: {} }),
  });
  if (!ok) {
    const err = new Error(`发布 ${locale} 失败 HTTP ${status}: ${JSON.stringify(json).slice(0, 200)}`);
    err.status = status;
    throw err;
  }
  return json.data;
}

// 拉取 Strapi 实际启用的 i18n locale 列表（admin 鉴权）。返回 [{code, name}]。
export async function listLocales(adminJwt) {
  const res = await fetch(`${URLBASE()}/i18n/locales`, {
    headers: { Authorization: `Bearer ${adminJwt}` },
  });
  if (res.status === 401) { const e = new Error('admin token expired (401) at i18n/locales'); e.status = 401; throw e; }
  const json = await res.json().catch(() => ([]));
  const arr = Array.isArray(json) ? json : (json.data || []);
  return arr.map((l) => ({ code: l.code, name: l.name || l.code, isDefault: !!l.isDefault }));
}

export async function listCategories() {
  const res = await fetch(`${URLBASE()}/api/categories?pagination[limit]=100`, {
    headers: authHeaders(),
  });
  const json = await res.json();
  return (json.data || []).map((c) => ({ id: c.id, documentId: c.documentId, name: c.name }));
}
