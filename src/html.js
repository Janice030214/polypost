// 把粘贴进来的富文本 HTML 转成 Strapi 用的 Markdown
// - 图片：data URL 直接解码上传；http(s) URL 尝试服务器抓取后上传；失败则保留原地址并标记
// - YouTube：iframe / 链接 转成 <youtube>VIDEO_ID</youtube>
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { youtubeId } from './convert.js';

// 提取 html 里所有 <img> 的 src
function extractImgSrcs(html) {
  const srcs = [];
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  return srcs;
}

// 取得某个 src 的二进制；返回 {buffer, mime} 或 null
async function fetchImage(src) {
  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) return null;
    const mime = m[1] || 'image/png';
    const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    return { buffer, mime };
  }
  if (/^https?:\/\//i.test(src)) {
    // 已在 Strapi CDN 的图，不重复上传（编辑现有文章时尤其重要）
    if (/(?:^|\/\/)static\.atlascloud\.ai\//.test(src)) return { skip: true };
    try {
      const res = await fetch(src);
      const mime = res.headers.get('content-type') || '';
      if (!res.ok || !mime.startsWith('image/')) return null;
      return { buffer: Buffer.from(await res.arrayBuffer()), mime };
    } catch {
      return null;
    }
  }
  return null;
}

// 把 youtube 的 iframe 预处理成纯文本标签，便于转 markdown
function preprocessYoutubeIframes(html) {
  return html.replace(/<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*><\/iframe>/gi, (full, src) => {
    const id = youtubeId(src.replace(/^\/\//, 'https://'));
    return id ? `<p>::youtube::${id}::</p>` : full;
  });
}

// 清理 Lark 文档复制过来的"暂时无法展示"占位符（表格 / 高亮块等不能导出的内容）
// 这些占位符如果保留会污染正文，AI 翻译也会翻译它，最好直接干掉
function cleanLarkPlaceholders(html) {
  return html.replace(
    /暂时无法在\s*Lark\s*文档外展示此内容|Temporarily unable to display this content outside of Lark Docs|This content cannot be displayed outside of Lark/gi,
    ''
  );
}

// 编辑模式：粘贴区可能直接含有 <youtube>id</youtube>（marked 把 markdown 渲染后保留下来）
// 把它们先转成占位符，避免 node-html-markdown 把它们当成未知标签丢掉
function preprocessYoutubeCustom(html) {
  return html.replace(/<youtube>\s*([A-Za-z0-9_-]+)\s*<\/youtube>/gi, (_, id) => `<p>::youtube::${id}::</p>`);
}

// 把 markdown 里独占一行的 youtube 链接转成 <youtube> 标签
function postprocessYoutube(md) {
  return md
    .replace(/^\s*::youtube::([A-Za-z0-9_-]+)::\s*$/gim, '<youtube>$1</youtube>')
    .replace(/^\s*\[[^\]]*\]\((https?:\/\/[^)]*(?:youtube\.com|youtu\.be)[^)]*)\)\s*$/gim, (full, url) => {
      const id = youtubeId(url);
      return id ? `<youtube>${id}</youtube>` : full;
    })
    .replace(/^\s*(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+)\s*$/gim, (full, url) => {
      const id = youtubeId(url);
      return id ? `<youtube>${id}</youtube>` : full;
    });
}

// 主转换。uploadImage(buffer, mime, hintName) => {id, url} | null
// 返回 { markdown, imageIds, firstImageId, imageCount, failedImages }
export async function htmlToMarkdown(html, { uploadImage, nameHint = 'image' } = {}) {
  let work = cleanLarkPlaceholders(preprocessYoutubeCustom(preprocessYoutubeIframes(html)));

  const srcs = [...new Set(extractImgSrcs(work))];
  const imageIds = [];
  const failedImages = [];
  let idx = 0;

  for (const src of srcs) {
    let img;
    try { img = await fetchImage(src); } catch { /* 失败下面统一处理 */ }
    if (!img) { failedImages.push(src); continue; }
    if (img.skip) continue; // 已在 CDN 的图，原样保留
    if (!uploadImage) continue; // 预览模式：只统计不上传
    // 简单魔数校验，避免把 HTML 错误页当图片上传到 Strapi 引发 500
    const b = img.buffer;
    const looksImage =
      (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // PNG
      (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||                  // JPEG
      (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) ||                  // GIF
      (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) || // RIFF (WebP)
      (b[0] === 0x3c && (b[1] === 0x3f || b[1] === 0x73));                  // SVG <? / <s
    if (!looksImage) { failedImages.push(src); continue; }
    idx += 1;
    const ext = (img.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('+xml', '');
    try {
      const up = await uploadImage(img.buffer, img.mime, `${nameHint}-${idx}.${ext}`);
      if (up?.url) {
        imageIds.push(up.id);
        work = work.split(src).join(up.url); // 替换所有该 src 出现处
      } else {
        failedImages.push(src);
      }
    } catch (e) {
      failedImages.push(src);
    }
  }

  let markdown = NodeHtmlMarkdown.translate(work);
  markdown = postprocessYoutube(markdown).replace(/\n{3,}/g, '\n\n').trim() + '\n';

  return {
    markdown,
    imageIds,
    firstImageId: imageIds[0] || null,
    imageCount: uploadImage ? imageIds.length : srcs.filter((s) => !failedImages.includes(s)).length,
    failedImages,
  };
}
