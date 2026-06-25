// Lark 开放平台交互：取 token、拉文档 blocks、下载媒体
const BASE = process.env.LARK_API_BASE || 'https://open.larksuite.com';

let cachedToken = null;
let tokenExpireAt = 0;

// 取 tenant_access_token（自建应用），带简单缓存
export async function getTenantToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt - 60_000) return cachedToken;

  const res = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`Lark 取 token 失败 (code ${json.code}): ${json.msg}`);
  }
  cachedToken = json.tenant_access_token;
  tokenExpireAt = now + json.expire * 1000;
  return cachedToken;
}

// 从普通文档链接里解析出 document_id（不含 wiki）
// 支持 .../docx/XXXX  和  .../docs/XXXX
function parseDocxId(url) {
  const u = String(url).trim();
  const m = u.match(/\/(?:docx|docs)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  // 也允许直接传 document_id
  if (/^[A-Za-z0-9]{16,}$/.test(u)) return u;
  throw new Error('无法从链接解析 document_id，请粘贴形如 https://xxx.larksuite.com/docx/XXXX 或 /wiki/XXXX 的链接');
}

// 把 wiki 节点 token 换成真正的文档 obj_token
async function wikiNodeToDocId(wikiToken) {
  const token = await getTenantToken();
  const url = new URL(`${BASE}/open-apis/wiki/v2/spaces/get_node`);
  url.searchParams.set('token', wikiToken);
  url.searchParams.set('obj_type', 'wiki');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`解析 wiki 节点失败 (code ${json.code}): ${json.msg}（确认应用已开 wiki:wiki:readonly 权限且能访问该知识库）`);
  }
  const node = json.data?.node;
  if (!node) throw new Error('wiki 节点返回为空');
  if (node.obj_type !== 'docx') {
    throw new Error(`该 wiki 节点是「${node.obj_type}」类型，目前只支持文档(docx)`);
  }
  return node.obj_token;
}

// 统一入口：把任意 Lark 链接（docx / docs / wiki）解析成 docx document_id
export async function resolveDocumentId(url) {
  const u = String(url).trim();
  const wiki = u.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) return wikiNodeToDocId(wiki[1]);
  return parseDocxId(u);
}

// 拉取一篇文档的所有 block（自动翻页）
export async function fetchAllBlocks(documentId) {
  const token = await getTenantToken();
  const items = [];
  let pageToken = '';
  do {
    const url = new URL(`${BASE}/open-apis/docx/v1/documents/${documentId}/blocks`);
    url.searchParams.set('page_size', '500');
    url.searchParams.set('document_revision_id', '-1');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (json.code !== 0) {
      throw new Error(`拉取文档 blocks 失败 (code ${json.code}): ${json.msg}`);
    }
    items.push(...(json.data.items || []));
    pageToken = json.data.has_more ? json.data.page_token : '';
  } while (pageToken);

  return items;
}

// 下载文档里的媒体（图片等），返回 { buffer, mime, fileToken }
export async function downloadMedia(fileToken) {
  const token = await getTenantToken();
  const res = await fetch(
    `${BASE}/open-apis/drive/v1/medias/${fileToken}/download`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`下载媒体 ${fileToken} 失败: HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime, fileToken };
}
