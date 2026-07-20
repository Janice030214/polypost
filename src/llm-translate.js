// 自定义模型翻译：用 OpenAI 兼容的聊天接口（AtlasCloud）翻译文章字段。
// 与 strapi-translate.js（复用 Strapi 官方插件）并列，走完全不同的通道。
// 配置来自前端 translateConfig，或 .env 的 TRANSLATE_* / 回退 VISION_*。
import { normalizeYoutubeTags } from './html.js';

// 目标语种 → 人类可读语言名（给模型看的）
const LOCALE_NAME = {
  en: 'English', zh: 'Simplified Chinese (简体中文)', 'zh-Hant': 'Traditional Chinese (繁體中文)',
  ja: 'Japanese (日本語)', ko: 'Korean (한국어)', de: 'German (Deutsch)', fr: 'French (Français)',
  es: 'Spanish (Español)', ru: 'Russian (Русский)', ar: 'Arabic (العربية)', pt: 'Portuguese (Português)',
  hi: 'Hindi (हिन्दी)', it: 'Italian (Italiano)', nl: 'Dutch (Nederlands)', pl: 'Polish (Polski)',
  tr: 'Turkish (Türkçe)', vi: 'Vietnamese (Tiếng Việt)', th: 'Thai (ไทย)',
  id: 'Indonesian (Bahasa Indonesia)', sv: 'Swedish (Svenska)',
};

const envCfg = () => ({
  base: (process.env.TRANSLATE_API_BASE || process.env.VISION_API_BASE || '').replace(/\/$/, ''),
  key: process.env.TRANSLATE_API_KEY || process.env.VISION_API_KEY,
  model: process.env.TRANSLATE_MODEL || 'qwen/qwen3.7-plus', // Qwen 翻译特长且便宜（$0.4/$1.6 per M）
});
function resolveCfg(override) {
  if (override && override.base && override.key && override.model) {
    return { base: override.base.replace(/\/$/, ''), key: override.key, model: override.model };
  }
  return envCfg();
}

export function isLlmTranslateEnabled(override) {
  const c = resolveCfg(override);
  return !!(c.base && c.key && c.model);
}

// 把 <youtube>ID</youtube> 换成模型不会翻译/改动的占位符，翻完再换回来。
function protectYoutube(text) {
  const tokens = [];
  const replaced = String(text || '').replace(
    /<youtube>\s*([^<\s]+?)\s*<\/youtube>/gi,
    (_, id) => { tokens.push(id); return `[[YTGUARD${tokens.length - 1}]]`; }
  );
  return { replaced, tokens };
}
function restoreYoutube(text, tokens) {
  if (!tokens.length) return text;
  return String(text || '').replace(
    /\[\[\s*YTGUARD(\d+)\s*\]\]/gi,
    (m, i) => (tokens[+i] !== undefined ? `<youtube>${tokens[+i]}</youtube>` : m)
  );
}

const SYS_PROMPT = (langName) => `You are a professional native ${langName} translator specializing in tech / AI blog content.
Translate the JSON field values from English into ${langName}. Return ONLY a valid JSON object with the SAME keys ("title", "description", "content", and "metaTitle" if present) and translated values — no explanations, no markdown fences.

Hard rules — follow exactly:
- Preserve ALL markdown structure verbatim: headings (#, ##, ###), bold **, italic *, links [text](url), lists, block quotes, tables, code fences.
- Do NOT translate or alter any URL, image path, code, or brand/product/model names (e.g. Seedance, DeepSeek, Strapi, Atlas Cloud, ByteDance, api.atlascloud.ai).
- Image alt text — the text inside ![ ... ] — MUST be translated.
- Keep every placeholder token like [[YTGUARD0]] EXACTLY as written. Never translate, renumber, space out, or remove them.
- Keep blank lines / paragraph breaks (\\n\\n) as in the source.
- Natural, fluent, publication-quality ${langName}. Translate meaning, not word-for-word.`;

// 翻译一个语种。fields: { title, description, content, metaTitle? , ... }
// 返回 { ...fields, title, description, content, metaTitle, locale }
export async function translateFieldsLLM(fields, targetLocale, override, onProgress = () => {}) {
  const c = resolveCfg(override);
  if (!c.base || !c.key || !c.model) throw new Error('自定义翻译模型未配置（base / key / model）');
  const langName = LOCALE_NAME[targetLocale] || targetLocale;

  const prot = protectYoutube(fields.content || '');
  const source = { title: fields.title || '', description: fields.description || '', content: prot.replaced };
  if (fields.metaTitle) source.metaTitle = fields.metaTitle;

  onProgress(`模型翻译为 ${langName}…`);
  const res = await fetch(`${c.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.model,
      messages: [
        { role: 'system', content: SYS_PROMPT(langName) },
        { role: 'user', content: JSON.stringify(source) },
      ],
      temperature: 0.2,
      max_tokens: 16000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`翻译接口 HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  let txt = json.choices?.[0]?.message?.content || '';
  if (!txt.trim()) throw new Error('翻译返回为空');

  let out;
  try { out = JSON.parse(txt); }
  catch {
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('翻译结果不是合法 JSON');
    out = JSON.parse(m[0]);
  }

  // 还原 youtube 标签 + 规范化（防止个别模型把标签写坏）
  const content = normalizeYoutubeTags(restoreYoutube(out.content ?? prot.replaced, prot.tokens));

  return {
    ...fields,
    title: (out.title ?? fields.title) || fields.title,
    description: (out.description ?? fields.description) || fields.description,
    content,
    metaTitle: out.metaTitle ?? fields.metaTitle,
    locale: targetLocale,
  };
}
