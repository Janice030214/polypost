import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --- 轻量加载 .env（避免额外依赖）---
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const {
  previewDoc, importDoc, previewHtml, importHtml,
  prepareAndTranslate, syncDrafts, publishAll,
  loadBlog, updateDrafts,
  prepare, translateOnly, translateOnlyLLM,
  CATEGORIES, SUPPORTED_LOCALES, listEnabledLocales,
} = await import('./src/pipeline.js');
const { reviewArticle, isReviewEnabled } = await import('./src/review.js');

const app = express();
// 简单 CORS（开发工具，仅本机，允许任何来源调用）
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '60mb' }));
// 静态文件禁用缓存，避免浏览器留着旧的 index.html
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(join(__dirname, 'public')));

app.get('/api/meta', async (_req, res) => {
  // locales 从 Strapi 动态拉取（跟随后台实际启用的语种）；失败自动回退静态列表
  let locales;
  try { locales = await listEnabledLocales(); }
  catch { locales = SUPPORTED_LOCALES.map((c) => ({ code: c, name: c })); }
  res.json({ categories: CATEGORIES, locales });
});

app.post('/api/preview', async (req, res) => {
  try {
    const data = await previewDoc(req.body.larkUrl);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/import', async (req, res) => {
  try {
    const { larkUrl, overrides, publish, locales, coverDataUrl } = req.body;
    const result = await importDoc({ larkUrl, overrides, publish, locales, coverDataUrl });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/preview-html', async (req, res) => {
  try {
    res.json(await previewHtml({ html: req.body.html || '' }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// AI 审稿：检查标题/描述/正文中明显的格式问题
app.post('/api/review', async (req, res) => {
  try {
    const { fields, reviewConfig } = req.body || {};
    if (!fields) return res.status(400).json({ error: '缺少 fields' });
    if (!isReviewEnabled(reviewConfig)) return res.json({ issues: [], skipped: true, reason: 'no_config' });
    const r = await reviewArticle(fields, reviewConfig);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/import-html', async (req, res) => {
  try {
    const { html, overrides, publish, locales, coverDataUrl } = req.body;
    const result = await importHtml({ html, overrides, publish, locales, coverDataUrl });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 四段式：1) 处理文章（搬图、传封面、解析）
app.post('/api/prepare', async (req, res) => {
  try { res.json(await prepare(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 四段式：2) 只翻译（基于已 prepare 好的 enFields）—— Strapi 官方插件
app.post('/api/translate', async (req, res) => {
  try { res.json(await translateOnly(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 四段式：2) 只翻译 —— 自定义模型（OpenAI 兼容 / AtlasCloud）
app.post('/api/translate-llm', async (req, res) => {
  try { res.json(await translateOnlyLLM(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 旧端点：保留向后兼容（一次性 prepare+翻译）
app.post('/api/translate-all', async (req, res) => {
  try {
    const r = await prepareAndTranslate(req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 2) 同步草稿
app.post('/api/sync', async (req, res) => {
  try {
    const r = await syncDrafts(req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 编辑模式：加载现有文章
app.get('/api/load-blog', async (req, res) => {
  try {
    res.json(await loadBlog(req.query.ref));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 编辑模式：覆盖更新（PUT 现有 documentId）
app.post('/api/update', async (req, res) => {
  try {
    res.json(await updateDrafts(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 3) 一键发布
app.post('/api/publish-all', async (req, res) => {
  try {
    const r = await publishAll(req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n  Lark→Strapi 上传器已启动：http://localhost:${PORT}\n`);
  if (!process.env.LARK_APP_ID || !process.env.STRAPI_TOKEN) {
    console.log('  ⚠️  还没配置 .env（LARK_APP_ID / LARK_APP_SECRET / STRAPI_TOKEN）\n');
  }
});
