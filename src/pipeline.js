// 编排：Lark 链接 / 粘贴 HTML -> Markdown -> 上传图片 -> 创建 Strapi 文章（+ 多语言）
import { resolveDocumentId, fetchAllBlocks, downloadMedia } from './lark.js';
import { blocksToMarkdown } from './convert.js';
import { htmlToMarkdown, normalizeYoutubeTags } from './html.js';
import { uploadFile, createBlog, createLocalization, publishLocale } from './strapi.js';
import { translateFields, adminLogin, withAdminAuthRetry } from './strapi-translate.js';
import { translateFieldsLLM } from './llm-translate.js';
import { describeImages, isVisionEnabled } from './vision.js';

// 按 URL 把 markdown 里每张图的 alt 替换成 alts[url]
function applyImageAlts(md, alts = {}) {
  if (!md) return md;
  return md.replace(
    /!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (full, oldAlt, url, title) => (alts[url] !== undefined ? `![${alts[url]}](${url}${title})` : full)
  );
}

// ===== 分类 + 多语言 URL 映射 =====
// Strapi v5 关系必须用 documentId（字符串，不会随发布而变），不能用 numeric id。
// path 是官网 URL 中 /blog/ 后面的那段。
export const CATEGORIES = [
  { docId: 'nk13xl36joeq2m6w5uucpapm', name: 'AI Usage & Technical Guides', path: 'guides',       hint: '一般教程（最常用）' },
  { docId: 'eij0fgb292v1ekej9f0vnnk4', name: 'AI Model Updates',            path: 'ai-updates',   hint: '上新模型 / 模型预告' },
  { docId: 'x2hgv054drq2k94fcmy2mo48', name: 'Business Case Studies',       path: 'case-studies', hint: '竞品对比 / 案例研究' },
];
const CAT_BY_DOCID = Object.fromEntries(CATEGORIES.map((c) => [c.docId, c]));

// locale -> 官网 URL 前缀（en 无前缀；zh-Hant 在 URL 里实际是 zh-TW）
const URL_LOCALE_PREFIX = {
  en: '', zh: 'zh', 'zh-Hant': 'zh-TW', ja: 'ja', ko: 'ko',
  de: 'de', fr: 'fr', es: 'es', ru: 'ru', ar: 'ar', pt: 'pt',
  // 2026-07-20 后台新增的语种
  hi: 'hi', it: 'it', nl: 'nl', pl: 'pl', tr: 'tr',
  vi: 'vi', th: 'th', id: 'id', sv: 'sv',
};
export const SUPPORTED_LOCALES = Object.keys(URL_LOCALE_PREFIX); // 20 个

function buildPublicUrl({ locale, categoryDocId, slug }) {
  const prefix = URL_LOCALE_PREFIX[locale] ?? locale;
  const cat = CAT_BY_DOCID[categoryDocId];
  const path = cat ? cat.path : 'guides';
  const head = prefix ? `/${prefix}` : '';
  return `https://www.atlascloud.ai${head}/blog/${path}/${slug}`;
}

// 从 page block 抽文档标题
function docTitle(items) {
  const page = items.find((b) => b.block_type === 1);
  const els = page?.page?.elements || [];
  return els.map((e) => e.text_run?.content ?? '').join('').trim();
}

// 取第一段非空文本作默认 description
function firstParagraph(markdown) {
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#') || t.startsWith('![') || t.startsWith('<youtube') ||
        t.startsWith('>') || t.startsWith('-') || t.startsWith('```') || t === '---') continue;
    return t.replace(/[*_`[\]()]/g, '').slice(0, 300);
  }
  return '';
}

// 取第一个 # 标题作默认标题
function firstHeading(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m) || markdown.match(/^#{1,3}\s+(.+)$/m);
  return m ? m[1].replace(/[*_`]/g, '').trim() : '';
}

// 去掉 heading 文本里的 "H1:" / "H2:" / "Heading 1:" / "Title:" 等标签前缀
function stripHeadingLabel(text) {
  return String(text || '').replace(
    /^\s*(H[1-6]|Heading\s*[1-6]?|Title|Subtitle)\s*[:：]\s*/i,
    ''
  ).trim();
}

// 清理字段值：去首尾空白、去包裹的引号（中英文）、去包裹的加粗、去 markdown 转义反斜杠
function cleanValue(v) {
  if (v == null) return '';
  let s = String(v).trim();
  // 反复剥掉外层引号（"…" / '…' / "…" / "…" / '…' / '…' / 「…」 / 『…』）
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^[「『"'""''](.*)[」』"'""'']$/s);
    if (!m) break;
    s = m[1].trim();
  }
  // 剥掉包裹整个值的 **加粗** / __加粗__（值内部没有其他 * _ 时才剥，避免误伤）
  const b = s.match(/^(\*{1,3}|_{2,3})([^*_]+)\1$/);
  if (b) s = b[2].trim();
  return s.replace(/\\([_*`\-\[\]()])/g, '$1');
}

// 严格只取 H1，并剥掉 "H1: " 这种标签前缀
function firstH1(md) {
  const m = (md || '').match(/^#\s+(.+)$/m);
  if (!m) return '';
  return cleanValue(stripHeadingLabel(m[1].replace(/[*_`]/g, '')));
}

// 规则：正文里有 H1 时，H1 = 文章 title；原本 frontmatter 的 title 自动晋升为 metaTitle
function applyH1TitleRule(meta, body) {
  const h1 = firstH1(body);
  if (!h1) return meta;
  const out = { ...meta };
  if (out.title && out.title !== h1 && !out.metaTitle) out.metaTitle = out.title;
  out.title = h1;
  return out;
}

// 文章开头常带一段 frontmatter（meta_title / meta_description / title / slug…），
// 解析出来对应到 Strapi 字段，并从正文里剔除（含分隔线 ---）
//
// 统一的"标签 → Strapi 字段"映射。key 已规范化（小写、去空格/下划线/连字符）。
// 值为 null 表示"认识这个标签，但直接丢弃（不进任何字段）"。
const META_LOOKUP = {
  title: 'title',
  metatitle: 'metaTitle', seotitle: 'metaTitle',
  metadescription: 'description', description: 'description',
  seodescription: 'description', metadesc: 'description',
  slug: 'slug', urlslug: 'slug',
  author: 'author',
  date: 'time', time: 'time', publishdate: 'time', publisheddate: 'time',
  keyword: null, keywords: null, tag: null, tags: null,
  focuskeyword: null, metakeyword: null, metakeywords: null,
  primarykeyword: null, targetkeyword: null, secondarykeyword: null, secondarykeywords: null,
  coveryoutubeid: 'coverYoutubeId',
};

// 把行首的 **Label:** value / **Label**: value / __Label__: value 解开成 Label: value
// （文章工具导出的元数据标签经常是加粗的，见线上事故：**Meta Title:** …）
function unwrapLabelEmphasis(t) {
  const m = t.match(/^(\*{1,3}|_{2,3})([^*_][\s\S]*?)\1\s*([:：]?)\s*(.*)$/);
  if (!m) return t;
  const inner = m[2].trim();
  if (/[:：]$/.test(inner)) return inner.replace(/\s*[:：]$/, '') + ': ' + m[4]; // **Label:** value
  if (m[3]) return inner + ': ' + m[4];                                          // **Label**: value
  return t; // 加粗但不是"标签: 值"形态，原样返回
}

// 识别"标签行"：支持加粗包裹、最多 4 个单词的多词标签（如 "Meta Title" / "Focus Keyword"），
// 以及括号后缀（如 "Title (H1)" / "Description (SEO)"——括号部分直接忽略）。
// 返回 { key（规范化）, value, multiWord } 或 null。
function matchMetaLabel(line) {
  const t = unwrapLabelEmphasis(String(line).trim().replace(/\\([_*`\-\[\]()])/g, '$1'));
  const m = t.match(/^([A-Za-z][A-Za-z0-9_-]*(?:[ \t]+[A-Za-z0-9_-]+){0,3})\s*(?:\([^()]{0,20}\))?\s*[:：]\s*(.+)$/);
  if (!m) return null;
  return {
    key: m[1].toLowerCase().replace(/[\s_-]+/g, ''),
    value: m[2],
    multiWord: /[ \t]/.test(m[1].trim()),
  };
}

function parseFrontmatter(md) {
  const meta = {};
  const lines = md.split('\n');
  let i = 0;
  let consumed = false;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { i++; continue; }
    const lab = matchMetaLabel(t);
    if (lab) {
      const field = META_LOOKUP[lab.key];
      // 已知键（含要丢弃的 keyword 系）一律消费；未知键沿旧行为只消费单词键，
      // 多词未知键（如 "Quick take: …"）当正文，停止 frontmatter 解析
      if (field !== undefined || !lab.multiWord) {
        if (field) {
          const v = cleanValue(lab.value);
          if (!meta[field] && v) meta[field] = v;
        }
        consumed = true;
        i++;
        continue;
      }
    }
    break;
  }
  if (!consumed) return { meta: {}, body: md };
  const body = lines.slice(i).join('\n').replace(/^\s+/, '');
  return { meta, body };
}

// 扫描正文里"标签段落"（不仅是文档开头）：
//   Title: ...           → metaTitle (有 H1 时) / title (无 H1 时)
//   Description: ...     → description
//   MetaTitle: ...       → metaTitle
//   Slug: ...            → slug
//   Keyword(s) / Tags    → 直接丢弃（不进 strapi 字段，但从正文删掉）
// 提取后从 body 删除这些行，避免出现在正文里。
// 正文中间的 Author:/Date: 多半是文章内容（署名、引用），不当元数据抽走
const INLINE_SKIP_FIELDS = new Set(['author', 'time']);

function extractInlineMeta(body, { hasH1 } = {}) {
  const lines = body.split('\n');
  const out = [];
  const meta = {};
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t)) { inFence = !inFence; out.push(line); continue; }
    if (inFence || !t) { out.push(line); continue; }
    // 跳过真正的正文结构行：heading / quote / code / 列表 / 图片 / HTML 标签
    // 注意：列表匹配 "- " "* " "+ "（标记+空格），**加粗** 不是列表，要继续走标签识别
    if (/^(#|>|`|[-*+]\s|\d+\.\s|!\[|<)/.test(t)) {
      out.push(line); continue;
    }
    const lab = matchMetaLabel(t);
    if (lab) {
      let field = META_LOOKUP[lab.key];
      if (field && INLINE_SKIP_FIELDS.has(field)) field = undefined;
      // user 规则：有 H1 时，body 里的 "title:" 视为 metaTitle
      if (lab.key === 'title' && hasH1) field = 'metaTitle';
      if (field !== undefined) {
        if (field && !meta[field]) {
          const v = cleanValue(lab.value);
          if (v) meta[field] = v;
        }
        continue; // 删掉这一行
      }
    }
    out.push(line);
  }
  return { meta, body: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n' };
}

// 正文若以 H1 开头，无条件去掉那一行——标题由 title 字段承载，
// 正文必须直接从段落开始（此前只在 H1===title 时才删，导致用户覆盖标题后 H1 残留）
function stripLeadingH1(md, _title) {
  if (!md) return md;
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (/^#\s+/.test(lines[i] || '')) {
    return lines.slice(i + 1).join('\n').replace(/^\s+/, '');
  }
  return md;
}

// 给每张正文图片追加 {width="…"} 属性。
// widths: 按 URL 指定宽度的对象，例如 { 'https://…/a.png': '80%' }
// defaultWidth: 没指定时用的默认值（用户可改）
// 幂等：会先剥掉已有的 {width=…} 标记再重写
function withImageWidth(md, widths = {}, defaultWidth = '64%') {
  if (!md) return md;
  const stripped = md.replace(
    /(!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))\{[^}]*width[^}]*\}/g,
    '$1'
  );
  return stripped.replace(
    /(!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\))(?!\{)/g,
    (full, imageMd, url) => `${imageMd}{width="${widths[url] || defaultWidth}"}`
  );
}

// 提取正文里所有图片（按出现顺序去重），并解析出当前的 width 属性
function extractImages(md) {
  if (!md) return [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)(\{[^}]*\})?/g;
  const map = new Map();
  let m;
  while ((m = re.exec(md))) {
    const url = m[2];
    if (map.has(url)) continue;
    const w = m[3] && m[3].match(/width\s*=\s*"?([^"\s}]+)/);
    map.set(url, { url, alt: m[1] || '', width: w ? w[1] : '64%' });
  }
  return [...map.values()];
}

// 从 documentId / 后台 URL 中解析出 documentId
function parseDocumentRef(ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  const m1 = s.match(/api::blog\.blog\/([a-z0-9]{20,40})/i); // 后台 URL
  if (m1) return m1[1];
  const m2 = s.match(/\/api\/blogs\/([a-z0-9]{20,40})/i);    // REST URL
  if (m2) return m2[1];
  if (/^[a-z0-9]{20,40}$/i.test(s)) return s;                // 纯 documentId
  return null;
}

// 通过内容 API token 拉 en 草稿（含 cover / category / localizations 元数据）
export async function loadBlog(ref) {
  const documentId = parseDocumentRef(ref);
  if (!documentId) throw new Error('无法识别 documentId。请填后台 URL 或文章的 documentId。');
  const base = (process.env.STRAPI_URL || '').replace(/\/$/, '');
  const token = process.env.STRAPI_TOKEN;
  const url = `${base}/api/blogs/${documentId}?populate%5Bcover%5D=true&populate%5Bcategory%5D=true&populate%5Blocalizations%5D=true&status=draft&locale=en`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  if (!res.ok || !json.data) {
    throw new Error(`加载失败 HTTP ${res.status}: ${json?.error?.message || JSON.stringify(json).slice(0, 200)}`);
  }
  const d = json.data;
  const existingLocales = ['en', ...((d.localizations || []).map((l) => l.locale))];

  // 并行拉所有非 en 语种的 content（以便 strip / 后续 sync 能覆盖到所有语种）
  const otherLocales = existingLocales.filter((l) => l !== 'en');
  const translations = {};
  await Promise.all(otherLocales.map(async (loc) => {
    try {
      const r = await fetch(
        `${base}/api/blogs/${documentId}?status=draft&locale=${encodeURIComponent(loc)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const j = await r.json();
      if (j?.data) {
        translations[loc] = {
          title: j.data.title || '',
          description: j.data.description || '',
          author: j.data.author || 'Atlas Cloud',
          time: j.data.time || '',
          slug: j.data.slug || '',
          content: normalizeYoutubeTags(j.data.content || ''),
          locale: loc,
          ...(j.data.metaTitle ? { metaTitle: j.data.metaTitle } : {}),
          ...(j.data.coverYoutubeId ? { coverYoutubeId: j.data.coverYoutubeId } : {}),
        };
      }
    } catch { /* 个别语种失败不影响整体 */ }
  }));

  const enContent = normalizeYoutubeTags(d.content || '');
  return {
    documentId: d.documentId,
    title: d.title || '',
    description: d.description || '',
    author: d.author || 'Atlas Cloud',
    time: d.time || '',
    slug: d.slug || '',
    metaTitle: d.metaTitle || '',
    coverYoutubeId: d.coverYoutubeId || '',
    content: enContent,
    categoryDocId: d.category?.documentId || null,
    categoryName: d.category?.name || null,
    coverId: d.cover?.id || null,
    coverUrl: d.cover?.url || null,
    existingLocales,
    publishedAt: d.publishedAt,
    images: extractImages(enContent),
    translations, // 每个语种完整字段；前端会写入 prepared.translations
  };
}

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `post-${Date.now()}`;
}

const noop = () => {};

// 共享：根据 title + markdown + coverId 建文章，并按需多语言翻译
async function finalize({ title, markdown, coverId, overrides, publish, locales }, onProgress) {
  if (!coverId && !overrides.coverYoutubeId) {
    throw new Error('没有封面：请在上方上传一张封面图（或填 coverYoutubeId）。');
  }
  const fields = {
    title,
    description: overrides.description || firstParagraph(markdown),
    author: overrides.author || 'Atlas Cloud',
    time: overrides.time || new Date().toISOString().slice(0, 10),
    slug: overrides.slug || slugify(title),
    content: withImageWidth(markdown),
    locale: overrides.locale || 'en',
  };
  if (coverId) fields.cover = coverId;
  if (overrides.category) fields.category = overrides.category;
  if (overrides.metaTitle) fields.metaTitle = overrides.metaTitle;
  if (overrides.coverYoutubeId) fields.coverYoutubeId = overrides.coverYoutubeId;

  const mainLocale = fields.locale;
  onProgress(`在 Strapi 创建文章（${mainLocale}）…`);
  const created = await createBlog(fields, { publish });

  const targets = (locales || []).filter((l) => l && l !== mainLocale);
  const translated = [];
  for (const loc of targets) {
    try {
      const tFields = await translateFields(fields, loc, onProgress);
      tFields.content = withImageWidth(tFields.content);
      onProgress(`创建 ${loc} 版本…`);
      await createLocalization(created.documentId, tFields, { publish });
      translated.push({ locale: loc, ok: true });
    } catch (e) {
      translated.push({ locale: loc, ok: false, error: e.message });
    }
  }

  onProgress('完成');
  return { created, fields, translated };
}

// 把 dataURL 封面上传到 Strapi，返回 file id
async function uploadCover(coverDataUrl, nameHint) {
  const m = String(coverDataUrl).match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] || 'image/png';
  const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const up = await uploadFile({ buffer, mime, name: `${nameHint}-cover.${ext}` });
  return up.id;
}

// ============ 方式一：Lark 文档链接 ============

export async function previewDoc(larkUrl, onProgress = noop) {
  onProgress('解析文档链接…');
  const documentId = await resolveDocumentId(larkUrl);
  onProgress('拉取文档内容…');
  const items = await fetchAllBlocks(documentId);
  onProgress(`共 ${items.length} 个 block，转换为 Markdown…`);
  const { markdown, imageTokens } = blocksToMarkdown(items);
  const title = docTitle(items);
  return { documentId, title, description: firstParagraph(markdown), slug: slugify(title), markdown, imageCount: imageTokens.length };
}

export async function importDoc({ larkUrl, overrides = {}, publish = false, locales = [], coverDataUrl } = {}, onProgress = noop) {
  onProgress('解析文档链接…');
  const documentId = await resolveDocumentId(larkUrl);
  onProgress('拉取文档内容…');
  const items = await fetchAllBlocks(documentId);
  onProgress('转换为 Markdown…');
  let { markdown, imageTokens } = blocksToMarkdown(items);
  const title = overrides.title || docTitle(items) || '未命名文档';

  const uniqueTokens = [...new Set(imageTokens)];
  const tokenToUrl = new Map();
  const tokenToId = new Map();
  let n = 0;
  for (const token of uniqueTokens) {
    n += 1;
    onProgress(`上传图片 ${n}/${uniqueTokens.length}…`);
    const media = await downloadMedia(token);
    const ext = (media.mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const up = await uploadFile({ buffer: media.buffer, mime: media.mime, name: `${slugify(title)}-${n}.${ext}` });
    tokenToUrl.set(token, up.url);
    tokenToId.set(token, up.id);
  }
  markdown = markdown.replace(/lark-image:\/\/([A-Za-z0-9_-]+)/g, (m, t) => tokenToUrl.get(t) || m);

  const { meta, body } = parseFrontmatter(markdown);
  const eff = { ...meta, ...overrides };
  const finalTitle = eff.title || title;
  markdown = stripLeadingH1(body, finalTitle);

  let coverId = null;
  if (coverDataUrl) { onProgress('上传封面…'); coverId = await uploadCover(coverDataUrl, slugify(finalTitle)); }
  if (!coverId && imageTokens.length) coverId = tokenToId.get(imageTokens[0]) || null;

  const r = await finalize({ title: finalTitle, markdown, coverId, overrides: eff, publish, locales }, onProgress);
  return { ...r, documentId, imageCount: uniqueTokens.length };
}

// ============ 方式二：粘贴富文本 HTML ============

export async function previewHtml({ html }, onProgress = noop) {
  onProgress('转换 HTML 为 Markdown…');
  const { markdown, imageCount, failedImages } = await htmlToMarkdown(html, { uploadImage: null });
  const { meta: fmMeta, body: afterFm } = parseFrontmatter(markdown);
  const hasH1 = !!firstH1(afterFm);
  const { meta: inlineMeta, body: bodyAfterInline } = extractInlineMeta(afterFm, { hasH1 });
  // 优先级：frontmatter > 正文标签段落
  const rawMeta = { ...inlineMeta, ...fmMeta };
  const meta = applyH1TitleRule(rawMeta, bodyAfterInline);
  const title = meta.title || firstHeading(bodyAfterInline);
  const body = stripLeadingH1(bodyAfterInline, title);
  return {
    title,
    description: meta.description || firstParagraph(body),
    metaTitle: meta.metaTitle || '',
    slug: meta.slug || slugify(title || 'post'),
    markdown: body,
    imageCount,
    failedCount: failedImages.length,
  };
}

export async function importHtml({ html, overrides = {}, publish = false, locales = [], coverDataUrl } = {}, onProgress = noop) {
  const titleHint = overrides.title || firstHeading(html.replace(/<[^>]+>/g, ' ')) || '未命名文章';
  let imgN = 0;
  onProgress('转换 HTML、搬运正文图片…');
  const { markdown: rawMd, firstImageId, imageCount, failedImages } = await htmlToMarkdown(html, {
    nameHint: slugify(titleHint),
    uploadImage: async (buffer, mime, name) => {
      imgN += 1;
      onProgress(`上传正文图片 ${imgN}…`);
      return uploadFile({ buffer, mime, name });
    },
  });
  // 解析 frontmatter + 正文里的标签段落；表单覆盖项优先级最高
  const { meta: fmMeta, body: afterFm } = parseFrontmatter(rawMd);
  const hasH1 = !!firstH1(afterFm);
  const { meta: inlineMeta, body: rawBody } = extractInlineMeta(afterFm, { hasH1 });
  const rawMeta = { ...inlineMeta, ...fmMeta };
  const meta = applyH1TitleRule(rawMeta, rawBody);
  const eff = { ...meta, ...overrides };
  const title = eff.title || firstHeading(rawBody) || '未命名文章';
  const markdown = stripLeadingH1(rawBody, title);

  let coverId = null;
  if (coverDataUrl) { onProgress('上传封面…'); coverId = await uploadCover(coverDataUrl, slugify(title)); }
  if (!coverId) coverId = firstImageId;

  const r = await finalize({ title, markdown, coverId, overrides: eff, publish, locales }, onProgress);
  return { ...r, imageCount, failedCount: failedImages.length };
}

// ============ 四段式 paste 流程：处理 → 翻译 → 同步草稿 → 发布 ============
// 拆开 prepare 和 translate，让用户在两者之间调整每张图的宽度

// 阶段 1：只处理文章（搬图、传封面、解析 frontmatter），不翻译
export async function prepare({
  html, overrides = {}, coverDataUrl, existingCoverId = null, visionConfig = null,
} = {}, onProgress = noop) {
  if (!html || !html.trim()) throw new Error('请先粘贴文章内容');

  const titleHint = overrides.title || firstHeading(html.replace(/<[^>]+>/g, ' ')) || '未命名文章';
  let imgN = 0;
  onProgress('转换 HTML、搬运正文图片…');
  const { markdown: rawMd, firstImageId, imageCount, failedImages } = await htmlToMarkdown(html, {
    nameHint: slugify(titleHint),
    uploadImage: async (buffer, mime, name) => {
      imgN += 1;
      onProgress(`上传正文图片 ${imgN}…`);
      return uploadFile({ buffer, mime, name });
    },
  });

  const { meta: fmMeta, body: afterFm } = parseFrontmatter(rawMd);
  const hasH1 = !!firstH1(afterFm);
  const { meta: inlineMeta, body: rawBody } = extractInlineMeta(afterFm, { hasH1 });
  const rawMeta = { ...inlineMeta, ...fmMeta };
  const meta = applyH1TitleRule(rawMeta, rawBody);
  const eff = { ...meta, ...overrides };
  const title = eff.title || firstHeading(rawBody) || '未命名文章';
  const markdown = stripLeadingH1(rawBody, title);

  let coverId = null;
  if (coverDataUrl) {
    onProgress('上传封面…');
    coverId = await uploadCover(coverDataUrl, slugify(title));
  }
  // 编辑模式：未上传新封面时，优先保留原封面（避免被正文第一张图替换掉）
  if (!coverId && existingCoverId) coverId = existingCoverId;
  if (!coverId) coverId = firstImageId;
  if (!coverId && !eff.coverYoutubeId) {
    throw new Error('没有封面：请上传一张封面图，或粘贴的文章里至少有一张可搬运的图。');
  }

  const enFields = {
    title,
    description: eff.description || firstParagraph(markdown),
    author: eff.author || 'Atlas Cloud',
    time: eff.time || new Date().toISOString().slice(0, 10),
    slug: eff.slug || slugify(title),
    content: markdown,
    locale: 'en',
  };
  if (coverId) enFields.cover = coverId;
  if (eff.category) enFields.category = String(eff.category);
  if (eff.metaTitle) enFields.metaTitle = eff.metaTitle;
  if (eff.coverYoutubeId) enFields.coverYoutubeId = eff.coverYoutubeId;

  // AI 识图：优先用前端传来的 visionConfig，否则用 .env 默认
  const images = extractImages(enFields.content);
  if (isVisionEnabled(visionConfig) && images.length) {
    onProgress(`AI 识图生成 alt (${images.length} 张)…`);
    const descs = await describeImages(images.map((i) => i.url), visionConfig);
    for (const img of images) {
      const d = descs.find((x) => x.url === img.url);
      if (d?.alt) img.alt = d.alt;
    }
  }

  onProgress('文章处理完成');
  return {
    enFields,
    coverId,
    imageCount,
    failedImageCount: failedImages.length,
    failedImages,
    images,
    visionEnabled: isVisionEnabled(visionConfig),
  };
}

// 阶段 2：只翻译，给定已 prepare 好的 enFields → 翻译到指定语言列表
// imageAlts: { url: alt } — 翻译前先把每张图的 alt 改成用户最终选定的英文 alt，
// 这样翻译器会自动把 alt 也翻译到各个语种。
export async function translateOnly({ enFields, locales = [], imageAlts = {} } = {}, onProgress = noop) {
  if (!enFields) throw new Error('缺少 enFields；请先点「① 处理文章」');
  // 把用户编辑过的 alt 写回 en content（再送翻译，所有语种 alt 都会被翻译）
  // youtube 标签先规范化，确保翻译时的占位符保护能匹配到
  const enWithAlts = { ...enFields, content: applyImageAlts(normalizeYoutubeTags(enFields.content), imageAlts) };
  const targets = (locales || []).filter((l) => l && l !== 'en' && URL_LOCALE_PREFIX[l] !== undefined);
  onProgress(`并行翻译 ${targets.length} 种语言…`);
  const results = await Promise.allSettled(
    targets.map((loc) => translateFields(enWithAlts, loc, () => {}))
  );
  const translations = {};
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') translations[targets[i]] = r.value;
    else failed.push({ locale: targets[i], error: r.reason?.message || String(r.reason) });
  }
  onProgress('翻译完成');
  return {
    enFields: enWithAlts, // alt 已写入；前端用这个更新 prepared.enFields
    translations,
    translatedLocales: Object.keys(translations),
    failedTranslations: failed,
  };
}

// 阶段 2（自定义模型版）：用 OpenAI 兼容模型（AtlasCloud）翻译，逻辑同 translateOnly，
// 只是把翻译器换成 translateFieldsLLM，并透传 translateConfig。
export async function translateOnlyLLM({ enFields, locales = [], imageAlts = {}, translateConfig = null } = {}, onProgress = noop) {
  if (!enFields) throw new Error('缺少 enFields；请先点「① 处理文章」');
  const enWithAlts = { ...enFields, content: applyImageAlts(normalizeYoutubeTags(enFields.content), imageAlts) };
  const targets = (locales || []).filter((l) => l && l !== 'en' && URL_LOCALE_PREFIX[l] !== undefined);
  onProgress(`并行翻译 ${targets.length} 种语言（自定义模型）…`);
  const results = await Promise.allSettled(
    targets.map((loc) => translateFieldsLLM(enWithAlts, loc, translateConfig, () => {}))
  );
  const translations = {};
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') translations[targets[i]] = r.value;
    else failed.push({ locale: targets[i], error: r.reason?.message || String(r.reason) });
  }
  onProgress('翻译完成');
  return {
    enFields: enWithAlts,
    translations,
    translatedLocales: Object.keys(translations),
    failedTranslations: failed,
  };
}

// （旧的合并版本保留为向后兼容，但 UI 不再用）

// 阶段 1：处理 HTML、搬正文图片、上传封面、解析 frontmatter、并行翻译所有目标语言
// 返回的对象前端持有，再原样回传给 /sync
export async function prepareAndTranslate({
  html, overrides = {}, coverDataUrl, locales = [], existingCoverId = null,
} = {}, onProgress = noop) {
  if (!html || !html.trim()) throw new Error('请先粘贴文章内容');

  const titleHint = overrides.title || firstHeading(html.replace(/<[^>]+>/g, ' ')) || '未命名文章';
  let imgN = 0;
  onProgress('转换 HTML、搬运正文图片…');
  const { markdown: rawMd, firstImageId, imageCount, failedImages } = await htmlToMarkdown(html, {
    nameHint: slugify(titleHint),
    uploadImage: async (buffer, mime, name) => {
      imgN += 1;
      onProgress(`上传正文图片 ${imgN}…`);
      return uploadFile({ buffer, mime, name });
    },
  });

  const { meta: fmMeta, body: afterFm } = parseFrontmatter(rawMd);
  const hasH1 = !!firstH1(afterFm);
  const { meta: inlineMeta, body: rawBody } = extractInlineMeta(afterFm, { hasH1 });
  const rawMeta = { ...inlineMeta, ...fmMeta };
  const meta = applyH1TitleRule(rawMeta, rawBody);
  const eff = { ...meta, ...overrides };
  const title = eff.title || firstHeading(rawBody) || '未命名文章';
  const markdown = stripLeadingH1(rawBody, title); // 去掉正文开头重复出现的 h1 标题

  let coverId = null;
  if (coverDataUrl) {
    onProgress('上传封面…');
    coverId = await uploadCover(coverDataUrl, slugify(title));
  }
  // 编辑模式：未上传新封面时，优先保留原封面（避免被正文第一张图替换掉）
  if (!coverId && existingCoverId) coverId = existingCoverId;
  if (!coverId) coverId = firstImageId; // 编辑模式：保留原封面
  if (!coverId && !eff.coverYoutubeId) {
    throw new Error('没有封面：请上传一张封面图，或粘贴的文章里至少有一张可搬运的图。');
  }

  // 主语言字段（不含 locale，那个在 finalize 阶段加）
  const enFields = {
    title,
    description: eff.description || firstParagraph(markdown),
    author: eff.author || 'Atlas Cloud',
    time: eff.time || new Date().toISOString().slice(0, 10),
    slug: eff.slug || slugify(title),
    content: markdown,
    locale: 'en',
  };
  if (coverId) enFields.cover = coverId;
  if (eff.category) enFields.category = String(eff.category); // documentId 字符串
  if (eff.metaTitle) enFields.metaTitle = eff.metaTitle;
  if (eff.coverYoutubeId) enFields.coverYoutubeId = eff.coverYoutubeId;

  // 并行翻译
  const targets = (locales || []).filter((l) => l && l !== 'en' && URL_LOCALE_PREFIX[l] !== undefined);
  onProgress(`翻译 ${targets.length} 种语言…`);
  const results = await Promise.allSettled(
    targets.map((loc) => translateFields(enFields, loc, () => {}))
  );
  const translations = {};
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') translations[targets[i]] = r.value;
    else failed.push({ locale: targets[i], error: r.reason?.message || String(r.reason) });
  }

  // 不再在这里塞 width — 留到 sync/update 阶段按用户为每张图指定的宽度统一刷

  onProgress('翻译完成');
  return {
    enFields,
    coverId,
    translations,        // { locale: fields }
    translatedLocales: Object.keys(translations),
    failedTranslations: failed,
    imageCount,
    failedImageCount: failedImages.length,
    images: extractImages(enFields.content), // 给前端做 per-image width 选择用
  };
}

// 按 imageWidths 把每张图的 {width=…} 重新刷一遍（en + 所有翻译）
// 顺带把 youtube 标签规范化——这是写入 Strapi 前的最后关卡，绝不能让 \<youtube> 落库
function applyImageWidths(enFields, translations, imageWidths = {}) {
  const en = { ...enFields, content: withImageWidth(normalizeYoutubeTags(enFields.content), imageWidths) };
  const out = {};
  for (const [loc, f] of Object.entries(translations)) {
    out[loc] = { ...f, content: withImageWidth(normalizeYoutubeTags(f.content), imageWidths) };
  }
  return { enFields: en, translations: out };
}

// 阶段 2：把准备好的 enFields + translations 同步到 Strapi（草稿）
export async function syncDrafts({ enFields, translations = {}, imageWidths = {} } = {}, onProgress = noop) {
  if (!enFields) throw new Error('缺少 enFields；请先点"一键翻译"');
  const { enFields: en, translations: trans } = applyImageWidths(enFields, translations, imageWidths);
  onProgress('创建 en 草稿…');
  const created = await createBlog(en, { publish: false });
  const documentId = created.documentId;

  const synced = [{ locale: 'en', ok: true }];
  for (const [locale, fields] of Object.entries(trans)) {
    try {
      onProgress(`创建 ${locale} 版本…`);
      await createLocalization(documentId, fields, { publish: false });
      synced.push({ locale, ok: true });
    } catch (e) {
      synced.push({ locale, ok: false, error: e.message });
    }
  }
  onProgress('同步完成');
  return { documentId, synced };
}

// 阶段 2b（编辑模式）：覆盖更新现有文章。用 PUT 更新 en，再 PUT 更新各 locale
export async function updateDrafts({ documentId, enFields, translations = {}, imageWidths = {} } = {}, onProgress = noop) {
  if (!documentId) throw new Error('缺少 documentId');
  if (!enFields) throw new Error('缺少 enFields；请先点「一键翻译」');
  const { enFields: en, translations: trans } = applyImageWidths(enFields, translations, imageWidths);
  const synced = [];
  try {
    onProgress('更新 en 草稿…');
    await createLocalization(documentId, en, { publish: false });
    synced.push({ locale: 'en', ok: true });
  } catch (e) {
    synced.push({ locale: 'en', ok: false, error: e.message });
  }
  for (const [locale, fields] of Object.entries(trans)) {
    try {
      onProgress(`更新 ${locale} 版本…`);
      await createLocalization(documentId, fields, { publish: false });
      synced.push({ locale, ok: true });
    } catch (e) {
      synced.push({ locale, ok: false, error: e.message });
    }
  }
  onProgress('覆盖更新完成');
  return { documentId, synced };
}

// 阶段 3：发布所有 locale，返回官网链接
export async function publishAll({ documentId, locales, categoryDocId, slug } = {}, onProgress = noop) {
  if (!documentId) throw new Error('缺少 documentId');
  onProgress('admin 登录…');

  const results = [];
  for (const loc of locales) {
    try {
      onProgress(`发布 ${loc}…`);
      // 每个 locale 都用 withAdminAuthRetry 包，401 时会自动重登并重试一次
      await withAdminAuthRetry((jwt) => publishLocale(documentId, loc, jwt));
      results.push({
        locale: loc,
        ok: true,
        url: buildPublicUrl({ locale: loc, categoryDocId, slug }),
      });
    } catch (e) {
      results.push({ locale: loc, ok: false, error: e.message });
    }
  }
  onProgress('发布完成');
  return { documentId, results };
}
