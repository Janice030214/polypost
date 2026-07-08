// AI 审稿：调 OpenAI 兼容接口检查文章里明显的格式错误
// 默认用 Atlas Cloud 的 deepseek-v4-pro

const envCfg = () => ({
  base: (process.env.REVIEW_API_BASE || process.env.VISION_API_BASE || '').replace(/\/$/, ''),
  key: process.env.REVIEW_API_KEY || process.env.VISION_API_KEY,
  model: process.env.REVIEW_MODEL,
});
function resolveCfg(override) {
  if (override && override.base && override.key && override.model) {
    return { base: override.base.replace(/\/$/, ''), key: override.key, model: override.model };
  }
  return envCfg();
}

export function isReviewEnabled(override) {
  const c = resolveCfg(override);
  return !!(c.base && c.key && c.model);
}

const PROMPT = `你是一位严格的博客内容审稿编辑。下面是从用户粘贴的文章中已经自动识别出来的字段和正文。请仔细检查并列出所有明显的格式错误。

最重要的一条规则：**文章正文必须直接从段落文字开始**——正文里不允许出现 H1 一级标题（"# " 开头的行），也不允许出现 "Title (H1):" / "**Title (H1)**:" 这类标题标签行。标题只存在于 title 字段。发现就整行删除（fixed 输出空字符串）。

请检查以下 14 种问题：
1. TITLE_PREFIX - 标题字段开头有残留的标签前缀（如 "H1:" / "Title:" / "Heading 1:" / "标题:" 等）
2. DESCRIPTION_PREFIX - 描述字段开头有残留的标签前缀
3. METATITLE_PREFIX - metaTitle 字段开头有残留的标签前缀
4. LARK_PLACEHOLDER - 正文里有 Lark 导出占位符（"暂时无法在 Lark 文档外展示此内容" 或类似文本）
5. CONTENT_LABEL - 正文中残留了元数据标签段落，这些行应该整行删除（fixed 输出空字符串 ""）。注意各种变体都算：
   - 普通形态："Title:" / "Description:" / "MetaTitle:" / "Slug:" / "Keyword:"
   - **加粗形态**："**Meta Title:** …" / "**Meta Description:** …" / "**Slug:** …"
   - 多词形态："Meta Title:" / "Meta Description:" / "Focus Keyword:"（可能带空格）
   - 括号形态："Title (H1):" / "**Title (H1)**:" / "Description (SEO):"（标签后带括号注记）
6. ESCAPED_BRACKETS - 字段值里有未处理的 markdown 转义反斜杠（如 \\[ \\] \\_ \\* \\(）
7. EMPTY_REQUIRED - title / description / slug 必填字段为空
8. WEIRD_SLUG - slug 含中文、空格、大写字母或不合法字符
9. TRAILING_QUOTES - 标题/描述/metaTitle 被引号包裹（"..." / '...' / 「...」）没有剥掉
10. DUPLICATE_TITLE - 正文开头第一行重复出现了标题文本
11. BARE_YOUTUBE_ID - 正文中有"裸的 YouTube 视频 ID"独占一行或独占一段（一般形如 11 位由 [A-Za-z0-9_-] 构成的字符串，看起来像 "PfrlmG9NqHo"、"6tCz39yCd3E"、"-bX_-O4IGNc"），但**没有**被 <youtube>...</youtube> 标签包裹。这种情况下，fixed 字段必须输出 <youtube>原ID</youtube>。注意：<youtube>ID</youtube> 是博客系统的自定义嵌入标签，必须**原样保留**，不允许修改、删除或改成 markdown 链接。
12. BROKEN_YOUTUBE_TAG - <youtube> 标签被 markdown 转义损坏，如 "\\<youtube>EiMyDbAFCHs\\</youtube>"（尖括号前有反斜杠）或 "<youtube>y1TGcPF\\_uvs</youtube>"（ID 里有 \\_）。fixed 必须输出干净的 <youtube>ID</youtube>（去掉所有反斜杠）。
13. CONTENT_H1 - 正文中出现 H1 一级标题行（"# " 开头）。正文不允许有 H1，标题只放 title 字段——整行删除，fixed 输出空字符串 ""。
14. SPELLING - **明显的**英文拼写 / 单词粘连错误（一眼就能看出来的那种），标题、描述、正文都要查。重点抓：
    - 两个单词漏了空格粘在一起，如 "beenannounced"→"been announced"、"ofthe"→"of the"、"isnot"→"is not"、"AIvideo"→"AI video"、"clickhere"→"click here"
    - 明显拼错的单词，如 "teh"→"the"、"recieve"→"receive"、"seperate"→"separate"、"occured"→"occurred"
    只标**确定是错**的；正常的专有名词、产品名、代码、URL、模型名（如 Seedance、DeepSeek、api.atlascloud.ai）**不要**当拼写错误。original 给出错的那个词或短片段，fixed 给正确写法。不确定就不要标。

对每个问题，返回：
- type: 上面列出的类型之一
- description: 一句中文说明
- location: "title" / "description" / "metaTitle" / "slug" / "content"
- original: 出问题的原始片段（短，最多 100 字）
- fixed: 修复后的片段（整行删除时输出空字符串 ""）

严格输出 JSON 对象：{"issues": [...]}。
没问题返回 {"issues": []}。
不要编造问题，只标真实明显的问题。不要重复同一个问题。`;

export async function reviewArticle({ title, description, metaTitle, slug, content }, override) {
  const c = resolveCfg(override);
  if (!c.base || !c.key || !c.model) return { issues: [], skipped: true };

  const userPayload = JSON.stringify({
    title: title || '',
    description: description || '',
    metaTitle: metaTitle || '',
    slug: slug || '',
    // 拼写错误可能出现在文章任何位置，尽量把全文交给模型（deepseek-v4-pro 长上下文）；
    // 只有超长文章才截断，避免尾部的错误被漏掉
    content: (content || '').slice(0, 40000),
  }, null, 2);

  const res = await fetch(`${c.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.model,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: userPayload },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_tokens: 4000,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`审稿接口 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  const txt = json.choices?.[0]?.message?.content || '{"issues":[]}';
  let parsed;
  try { parsed = JSON.parse(txt); }
  catch {
    // 模型偶尔会输出非严格 JSON，尝试抠出第一个 {...} 块
    const m = txt.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { issues: [] };
  }
  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];

  // ---- 确定性兜底：LLM 可能漏标，正则扫一遍补齐，避免遗漏 ----
  for (const det of deterministicContentScan(content)) {
    // 避免和 LLM 已经标出来的重复（按 original 片段去重）
    if (issues.some((it) => it.original && det.original &&
        (it.original.includes(det.original) || det.original.includes(it.original)))) continue;
    issues.push(det);
  }

  return { issues, model: c.model };
}

// 确定性正文扫描（不依赖 LLM，可单独测试）：
//   1. 被转义/损坏的 <youtube> 标签（\<youtube>… / ID 里的 \_）
//   2. 裸的 11 位 YouTube 视频 ID 独占一行
//   3. 残留的元数据标签行（Title: / **Meta Title:** / Slug: 等，含加粗与多词形态）
export function deterministicContentScan(content) {
  const issues = [];
  const md = content || '';
  // 先把代码块、行内代码去掉，避免误判
  const scanText = md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]+`/g, '');

  // 1) 转义/损坏的 <youtube> 标签
  const BROKEN_YT = /\\?<\s*youtube\s*\\?>\s*([A-Za-z0-9_\\-]{5,40}?)\s*\\?<\s*\/\s*youtube\s*\\?>/gi;
  for (const m of scanText.matchAll(BROKEN_YT)) {
    const cleanId = m[1].replace(/\\/g, '');
    const fixed = `<youtube>${cleanId}</youtube>`;
    if (m[0] === fixed) continue; // 本来就规范
    issues.push({
      type: 'BROKEN_YOUTUBE_TAG',
      description: '<youtube> 标签被 markdown 转义损坏',
      location: 'content',
      original: m[0],
      fixed,
    });
  }
  // 后续扫描先剔除所有 youtube 标签（含损坏形态），避免 ID 被当成裸 ID 重复报
  const noYt = scanText.replace(BROKEN_YT, '');

  // 2) 独占一行（或一段）的 11 位 ID（YouTube 视频 ID 的标准长度）
  const seen = new Set();
  for (const m of noYt.matchAll(/(^|\n)\s*([A-Za-z0-9_-]{11})\s*(?=\n|$)/g)) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    issues.push({
      type: 'BARE_YOUTUBE_ID',
      description: '裸 YouTube 视频 ID 没有用 <youtube> 标签包裹',
      location: 'content',
      original: id,
      fixed: `<youtube>${id}</youtube>`,
    });
  }

  // 3) 正文里的 H1 行（正文必须直接从段落开始，标题只放 title 字段）
  //    + 残留的元数据标签行（含 **加粗**、多词、括号后缀形态，如 "**Title (H1)**:"）
  const LABEL_RE = /^(?:\*{1,3}|_{2,3})?\s*(meta[ _-]?title|meta[ _-]?description|meta[ _-]?desc|seo[ _-]?title|seo[ _-]?description|title|description|slug|keywords?|tags?|focus[ _-]?keyword|meta[ _-]?keywords?)\s*(?:\([^()]{0,20}\))?\s*(?:[:：]\s*(?:\*{1,3}|_{2,3})|(?:\*{1,3}|_{2,3})\s*[:：]|[:：])\s*\S/i;
  for (const rawLine of noYt.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#\s+/.test(line)) {
      issues.push({
        type: 'CONTENT_H1',
        description: '正文包含 H1 一级标题，应整行删除（正文直接从段落开始）',
        location: 'content',
        original: line,
        fixed: '',
      });
      continue;
    }
    if (/^(#|>|`|[-*+]\s|\d+\.\s|!\[|<)/.test(line)) continue; // 结构行不算
    const norm = line.replace(/\\([_*`\-\[\]()])/g, '$1');
    const m = norm.match(LABEL_RE);
    if (!m) continue;
    issues.push({
      type: 'CONTENT_LABEL',
      description: `正文残留元数据标签行（${m[1]}），应整行删除`,
      location: 'content',
      original: line,
      fixed: '',
    });
  }

  return issues;
}
