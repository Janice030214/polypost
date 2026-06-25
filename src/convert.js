// 把 Lark docx 的 block 列表转换成 Strapi 用的 Markdown
//
// 设计要点：
// - 图片先输出占位符 lark-image://{fileToken}，由上层下载并上传到 Strapi 后替换为真实 URL
// - YouTube 链接转成自定义标签 <youtube>VIDEO_ID</youtube>
// - 返回 { markdown, imageTokens }（imageTokens 按出现顺序，方便选第一张作封面）

// block_type -> 该 block 的内容字段名（含 elements 的文本类）
const TEXT_FIELD = {
  2: 'text',
  3: 'heading1', 4: 'heading2', 5: 'heading3',
  6: 'heading4', 7: 'heading5', 8: 'heading6',
  9: 'heading7', 10: 'heading8', 11: 'heading9',
  12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo',
};

const HEADING_PREFIX = {
  3: '# ', 4: '## ', 5: '### ', 6: '#### ', 7: '##### ', 8: '###### ',
  9: '###### ', 10: '###### ', 11: '###### ',
};

// 从各种 youtube 链接里抽 video id
export function youtubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1) || null;
    if (host.endsWith('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts|v)\/([A-Za-z0-9_-]+)/);
      if (m) return m[2];
    }
  } catch {
    /* 不是合法 URL，忽略 */
  }
  return null;
}

function decodeLink(url) {
  if (!url) return '';
  try { return decodeURIComponent(url); } catch { return url; }
}

// 渲染一行的 inline elements -> markdown 文本
function renderElements(elements = []) {
  let out = '';
  for (const el of elements) {
    const tr = el.text_run;
    if (!tr) continue; // mention / equation 等暂按空处理
    let text = tr.content ?? '';
    const s = tr.text_element_style || {};
    if (s.inline_code) text = '`' + text + '`';
    if (s.bold) text = '**' + text + '**';
    if (s.italic) text = '*' + text + '*';
    if (s.strikethrough) text = '~~' + text + '~~';
    const link = s.link && decodeLink(s.link.url);
    if (link) text = `[${text}](${link})`;
    out += text;
  }
  return out;
}

// 整段是否就是一个 youtube 链接（用于转成 <youtube> 标签）
function soleYoutube(elements = []) {
  const runs = elements.filter((e) => e.text_run && (e.text_run.content || '').trim());
  if (runs.length !== 1) return null;
  const tr = runs[0].text_run;
  const url = (tr.text_element_style?.link && decodeLink(tr.text_element_style.link.url)) || tr.content;
  return youtubeId(url);
}

const CODE_LANG = {
  1: 'plaintext', 8: 'bash', 22: 'go', 28: 'javascript', 30: 'json',
  43: 'python', 49: 'shell', 52: 'sql', 53: 'swift', 56: 'typescript',
  63: 'yaml', 24: 'html', 25: 'css', 12: 'c', 13: 'cpp', 27: 'java',
};

export function blocksToMarkdown(items) {
  const byId = new Map(items.map((b) => [b.block_id, b]));
  const page = items.find((b) => b.block_type === 1) || items[0];
  const imageTokens = [];

  const lines = [];

  function pushBlank() {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
  }

  function renderChildren(childIds = [], depth = 0) {
    let orderedIndex = 0;
    for (let i = 0; i < childIds.length; i++) {
      const b = byId.get(childIds[i]);
      if (!b) continue;
      const indent = '  '.repeat(depth);
      const type = b.block_type;

      // 维护有序列表序号：连续的 ordered 才累加
      if (type === 13) orderedIndex += 1; else orderedIndex = 0;

      switch (type) {
        case 1: // page：直接渲染子节点
          renderChildren(b.children, depth);
          break;

        case 2: { // 普通段落
          const el = b.text?.elements || [];
          const yt = soleYoutube(el);
          if (yt) {
            pushBlank();
            lines.push(`<youtube>${yt}</youtube>`);
            pushBlank();
          } else {
            const text = renderElements(el);
            pushBlank();
            lines.push(text);
            pushBlank();
          }
          renderChildren(b.children, depth);
          break;
        }

        case 3: case 4: case 5: case 6:
        case 7: case 8: case 9: case 10: case 11: { // 标题
          const field = TEXT_FIELD[type];
          const text = renderElements(b[field]?.elements);
          pushBlank();
          lines.push(HEADING_PREFIX[type] + text);
          pushBlank();
          renderChildren(b.children, depth);
          break;
        }

        case 12: { // 无序列表
          const text = renderElements(b.bullet?.elements);
          lines.push(`${indent}- ${text}`);
          renderChildren(b.children, depth + 1);
          break;
        }

        case 13: { // 有序列表
          const text = renderElements(b.ordered?.elements);
          lines.push(`${indent}${orderedIndex}. ${text}`);
          renderChildren(b.children, depth + 1);
          break;
        }

        case 17: { // 待办
          const todo = b.todo;
          const checked = todo?.style?.done ? 'x' : ' ';
          lines.push(`${indent}- [${checked}] ${renderElements(todo?.elements)}`);
          renderChildren(b.children, depth + 1);
          break;
        }

        case 14: { // 代码块
          const lang = CODE_LANG[b.code?.style?.language] || '';
          const code = (b.code?.elements || []).map((e) => e.text_run?.content ?? '').join('');
          pushBlank();
          lines.push('```' + lang);
          lines.push(code);
          lines.push('```');
          pushBlank();
          break;
        }

        case 15: { // 引用（单行）
          pushBlank();
          lines.push('> ' + renderElements(b.quote?.elements));
          pushBlank();
          break;
        }

        case 19: { // callout 高亮块：当作引用渲染其子节点
          pushBlank();
          renderChildren(b.children, depth);
          pushBlank();
          break;
        }

        case 22: { // 分割线
          pushBlank();
          lines.push('---');
          pushBlank();
          break;
        }

        case 27: { // 图片
          const token = b.image?.token;
          if (token) {
            imageTokens.push(token);
            pushBlank();
            lines.push(`![](lark-image://${token})`);
            pushBlank();
          }
          break;
        }

        case 26: case 30: { // iframe / 内嵌（视频等）
          const url = decodeLink(b.iframe?.component?.url);
          const yt = youtubeId(url);
          pushBlank();
          if (yt) lines.push(`<youtube>${yt}</youtube>`);
          else if (url) lines.push(url);
          pushBlank();
          break;
        }

        default: {
          // 兜底：若该 block 有 elements 文本就尽量渲染，否则跳过并渲染子节点
          const field = TEXT_FIELD[type];
          if (field && b[field]?.elements) {
            pushBlank();
            lines.push(renderElements(b[field].elements));
            pushBlank();
          }
          renderChildren(b.children, depth);
        }
      }
    }
  }

  renderChildren(page?.children || [], 0);

  // 收尾：压掉多余空行
  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { markdown, imageTokens };
}
