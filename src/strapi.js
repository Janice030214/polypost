// Strapi v5 交互：上传图片、创建 blog 文章
const URLBASE = () => (process.env.STRAPI_URL || '').replace(/\/$/, '');
const TOKEN = () => process.env.STRAPI_TOKEN;

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN()}`, ...extra };
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

// 创建一篇 blog（默认草稿）。fields 直接对应 Strapi blog 字段
export async function createBlog(fields, { publish = false } = {}) {
  const qs = publish ? '?status=published' : '?status=draft';
  const res = await fetch(`${URLBASE()}/api/blogs${qs}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: fields }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`创建文章失败 HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

// 给已存在的文档(documentId)新增/更新一个语言版本（Strapi v5 i18n）
export async function createLocalization(documentId, fields, { publish = false } = {}) {
  const status = publish ? 'published' : 'draft';
  const url = `${URLBASE()}/api/blogs/${documentId}?locale=${encodeURIComponent(fields.locale)}&status=${status}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ data: fields }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`创建 ${fields.locale} 版本失败 HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json.data;
}

// 发布某个 locale 的草稿（admin 鉴权，复用后台 Publish 动作）
export async function publishLocale(documentId, locale, adminJwt) {
  const url = `${URLBASE()}/content-manager/collection-types/api::blog.blog/${documentId}/actions/publish?locale=${encodeURIComponent(locale)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`发布 ${locale} 失败 HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    err.status = res.status; // 让上层能识别 401 触发重登重试
    throw err;
  }
  return json.data;
}

export async function listCategories() {
  const res = await fetch(`${URLBASE()}/api/categories?pagination[limit]=100`, {
    headers: authHeaders(),
  });
  const json = await res.json();
  return (json.data || []).map((c) => ({ id: c.id, documentId: c.documentId, name: c.name }));
}
