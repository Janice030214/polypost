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

请检查以下 10 种问题：
1. TITLE_PREFIX - 标题字段开头有残留的标签前缀（如 "H1:" / "Title:" / "Heading 1:" / "标题:" 等）
2. DESCRIPTION_PREFIX - 描述字段开头有残留的标签前缀
3. METATITLE_PREFIX - metaTitle 字段开头有残留的标签前缀
4. LARK_PLACEHOLDER - 正文里有 Lark 导出占位符（"暂时无法在 Lark 文档外展示此内容" 或类似文本）
5. CONTENT_LABEL - 正文中残留了 "Title:" / "Description:" / "MetaTitle:" / "Slug:" 这种应该作为元数据被剥离的标签段落
6. ESCAPED_BRACKETS - 字段值里有未处理的 markdown 转义反斜杠（如 \\[ \\] \\_ \\* \\(）
7. EMPTY_REQUIRED - title / description / slug 必填字段为空
8. WEIRD_SLUG - slug 含中文、空格、大写字母或不合法字符
9. TRAILING_QUOTES - 标题/描述/metaTitle 被引号包裹（"..." / '...' / 「...」）没有剥掉
10. DUPLICATE_TITLE - 正文开头第一行重复出现了标题文本

对每个问题，返回：
- type: 上面 10 种之一
- description: 一句中文说明
- location: "title" / "description" / "metaTitle" / "slug" / "content"
- original: 出问题的原始片段（短，最多 100 字）
- fixed: 修复后的片段

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
    // 正文太长就截前 8000 字（基础问题都集中在开头）
    content: (content || '').slice(0, 8000),
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
      max_tokens: 2000,
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
  return { issues, model: c.model };
}
