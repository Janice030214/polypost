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

const PROMPT =
  'You are writing accessibility alt text for a blog image. ' +
  'Hard constraint: the description MUST be 12 words or fewer — count your words and revise until it fits. ' +
  'Prefer concrete nouns over filler ("a screenshot of …", "an illustration showing …"). ' +
  'Skip generic preambles like "this image shows" — just describe the subject. ' +
  'Output one plain English line. No quotes, no trailing period, no explanations.';

export async function describeImage(url, override) {
  const c = resolveCfg(override);
  if (!c.base || !c.key || !c.model) return '';
  try {
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
        max_tokens: 60,
        temperature: 0.2,
      }),
    });
    if (!res.ok) return '';
    const json = await res.json();
    let txt = json.choices?.[0]?.message?.content || '';
    txt = txt.trim().replace(/^["'](.*)["']$/s, '$1').replace(/\.$/, '').trim();
    // 清理可能的换行 / 多余空白
    return txt.replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

// 并行给一批图片生成 alt
export async function describeImages(urls, override) {
  const out = await Promise.allSettled(urls.map((u) => describeImage(u, override)));
  return urls.map((url, i) => ({ url, alt: out[i].status === 'fulfilled' ? out[i].value : '' }));
}
