// AI 识图：用 OpenAI 兼容的视觉模型给每张正文图生成简短 alt
// 配置 (.env)：VISION_API_BASE, VISION_API_KEY, VISION_MODEL
// 未配置时函数会返回空字符串，不会让流程崩

// 默认从 env 读；若调用方传 override，则用 override
const envCfg = () => ({
  base: (process.env.VISION_API_BASE || '').replace(/\/$/, ''),
  key: process.env.VISION_API_KEY,
  model: process.env.VISION_MODEL,
});
function resolveCfg(override) {
  if (override && override.base && override.key && override.model) {
    return { base: override.base.replace(/\/$/, ''), key: override.key, model: override.model };
  }
  return envCfg();
}

export function isVisionEnabled(override) {
  const c = resolveCfg(override);
  return !!(c.base && c.key && c.model);
}

// 提示词刻意简短：越是"数词数、反复修改"这类指令，思考型模型（gemini 等）
// 越容易烧大量隐藏思考 token 甚至把思考文字泄漏进答案
const PROMPT =
  'Write accessibility alt text for this blog image. ' +
  'One plain English line, 12 words or fewer, concrete and specific. ' +
  'No quotes, no trailing period, no explanations.';

// 清洗模型输出：偶尔思考文字会泄漏进 content（如 \"12). Exactly 12 words. * …\"）
function cleanAlt(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  // 泄漏时最终答案通常在最后一个引号里
  const quotes = [...t.matchAll(/"([^"\n]{8,})"/g)];
  if (quotes.length) t = quotes[quotes.length - 1][1];
  // 多行时取最后一个非空行（最终答案一般在最后）
  const lines = t.split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.length) t = lines[lines.length - 1];
  t = t.replace(/^[-*#>\s]+/, '');                     // 行首列表符号
  t = t.replace(/^["'](.*)["']$/s, '$1').replace(/\.$/, '').trim();
  return t.replace(/\s+/g, ' ');
}

export async function describeImage(url, override) {
  const c = resolveCfg(override);
  if (!c.base || !c.key || !c.model) return '';

  const tryOnce = async () => {
    const res = await fetch(`${c.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: c.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url } },
          ],
        }],
        // 大余量：gemini 等模型有"隐藏思考 token"（计入 completion 配额但不在 content 里），
        // 上限太小会 finish_reason=length、答案说一半被截断。实测本提示词要 ~900 token。
        max_tokens: 1024,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      // 失败别静默吞掉——模型下线（HTTP 400 not found）这类问题要能在服务器日志里看到
      const body = await res.text().catch(() => '');
      console.warn(`[vision] ${c.model} HTTP ${res.status}: ${body.slice(0, 150)} (${url.slice(0, 80)})`);
      return '';
    }
    const json = await res.json();
    return cleanAlt(json.choices?.[0]?.message?.content);
  };

  // API 偶发返回空内容 / 思考泄漏导致超长（并行请求下更常见），坏结果重试一次
  const suspicious = (t) => !t || t.split(' ').length > 18;
  try {
    let txt = await tryOnce();
    if (suspicious(txt)) {
      console.warn(`[vision] ${c.model} 结果异常（${txt ? '过长' : '为空'}），重试一次 (${url.slice(0, 80)})`);
      const retry = await tryOnce();
      // 用更合理的那个：优先非空且不超长的
      if (!suspicious(retry)) txt = retry;
      else if (!txt) txt = retry;
    }
    return txt;
  } catch (e) {
    console.warn(`[vision] ${c.model} 调用异常: ${e.message}`);
    return '';
  }
}

// 并行给一批图片生成 alt
export async function describeImages(urls, override) {
  const out = await Promise.allSettled(urls.map((u) => describeImage(u, override)));
  return urls.map((url, i) => ({ url, alt: out[i].status === 'fulfilled' ? out[i].value : '' }));
}
