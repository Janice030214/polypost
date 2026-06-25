<img width="2048" height="1152" alt="polypost介绍" src="https://github.com/user-attachments/assets/36b38617-184b-4e80-8447-d2d465f8e9d1" />

# Polypost

> **One-click multilingual blog publisher for Strapi.**
> Paste an article, auto-translate to 11 languages, and publish — in minutes.

Polypost replaces the tedious manual workflow of creating a blog post in Strapi (filling out 7+ fields, uploading each image, clicking "Translate with AI" 10 times, then clicking "Publish" 11 times) with a single 4-step web UI that finishes the entire pipeline in under 5 minutes.

👋 **零基础第一次用？看这里：[手把手安装教程 →](./安装教程.md)**

[中文用户文档 →](./用户文档.md)

---

## Table of contents

- [Why Polypost](#why-polypost)
- [Features](#features)
- [Screenshots](#screenshots)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Detailed workflow](#detailed-workflow)
- [HTTP API reference](#http-api-reference)
- [Project structure](#project-structure)
- [Customization](#customization)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why Polypost

Publishing a single multilingual blog post manually to a Strapi i18n-enabled backend usually costs **30–60 minutes** of dead-tree busywork:

| Manual step                                              | Estimated time |
| -------------------------------------------------------- | -------------: |
| Create blog entry, fill title/desc/slug/author/date/etc. |        ~5 min  |
| Upload each body image to media library                  |   ~5–10 min    |
| Upload cover, pick category                              |        ~1 min  |
| Click "Translate with AI" per locale (×10)               |   ~10–20 min   |
| Review each translation, write image `alt`               |       ~10 min  |
| Click Publish per locale (×11)                           |        ~5 min  |
| **Total**                                                | **30–60 min**  |

Polypost compresses all of this into:

1. **Paste** the article
2. **Drop** a cover image
3. Click **Process → Translate → Sync → Publish**

The whole flow runs in **3–5 minutes** end-to-end, and the moment it finishes you get a list of clickable public URLs for every locale.

---

## Features

### Core pipeline
- **Paste-to-publish**: paste rich text from Lark/Notion/WordPress/Google Docs/any webpage and convert it cleanly to Markdown.
- **Image hosting**: every `<img>` in the pasted content is automatically downloaded and re-uploaded to the Strapi media library so links never break.
- **Cover handling**: drag-and-drop cover image, or auto-use the first body image; in edit mode the existing cover is preserved.
- **Parallel translation**: all selected locales translate in parallel through Strapi's existing `strapi-ai-translator` plugin (reuses your Strapi-side LLM credits — no extra AI key needed).
- **One-shot publish**: publishes every locale draft via the admin Publish action and returns the public URLs.

### Smart parsing
- **Frontmatter detection**: recognises `meta_title:` / `meta_description:` / `title:` / `slug:` / `keyword:` etc. lines at the top of pasted content and maps them to the right Strapi fields.
- **Inline label extraction**: also recognises `Title:` / `Description:` / `Slug:` paragraphs anywhere in the body, extracts them, and removes them from the content.
- **H1 promotion rule**: if the body has an H1 like `# Article title`, that becomes the article title and the frontmatter `title:` is automatically promoted to `metaTitle`.
- **YouTube embedding**: pasted YouTube iframes / links are converted to Strapi's `<youtube>VIDEO_ID</youtube>` custom tag.
- **Lark placeholder cleanup**: removes Lark's "this content can't be displayed outside Lark Docs" export placeholders.

### AI assistance
- **Auto-alt with vision model**: each body image is described in 12 words or fewer by a vision model (OpenAI-compatible — defaults to `qwen3-vl-30b-a3b-instruct`).
- **AI review on preview**: clicking "Preview" sends the parsed article to a text LLM (defaults to `deepseek-v4-pro`) which checks for 10 categories of common authoring problems (leftover `H1:` prefix, Lark placeholders, dangling escape backslashes, weird slugs, etc.) and produces a fixable issues list with a one-click "Apply all fixes" button.

### Format cleanup
- **`🧹 Clean format`**: a single button that:
  - Strips `https://api.atlascloud.ai` hyperlinks and inserts a zero-width space so CKEditor doesn't auto-link bare URLs.
  - Removes inline `` `code` `` formatting outside code blocks.
  - Normalises spacing: H2 gets a blank line before, H3 hugs the paragraph above, images sit tight to surrounding text, tables get blank lines around them (required by Markdown), `<youtube>` tags get blank lines around, horizontal rules (`---`) get blank lines around (prevents Setext-H2 mis-parsing), consecutive images get a blank line between, paragraph runs collapse to single-line spacing.
  - Auto-pushes the cleaned result to Strapi if the article is already synced/loaded.

### Per-image controls
- **Width per image**: each body image gets 64% / 80% / 100% / custom width buttons that get baked into the saved Markdown as `{width="64%"}` attributes.
- **Editable alt**: AI-suggested alt is pre-filled but editable; alts are written into the English source before translation so they get localized automatically.

### Edit mode
- Paste a `documentId` or admin URL → **Load** pulls the entire article including all 11 locales' content, populates every form field (title/desc/metaTitle/slug/author/date/cover/category), renders the existing body Markdown back into the paste area as editable HTML, restores existing image widths and alts, and pre-checks the language checkboxes for whichever locales already exist.
- Edits flow through the same Translate → Sync → Publish path but use PUT against the existing `documentId` instead of creating new entries.

### UI
- **Bilingual** UI (Chinese / English) with a one-click language toggle in the top right. Choice is persisted in `localStorage`.
- Light purple "tech paper" aesthetic with washi-tape decorations on cards.
- Custom SVG favicon.

---

## Screenshots

<details>
<summary>Click to expand</summary>

> Add screenshots of: the main page, the image widths panel, the AI review results, the publish-all output, the edit mode load flow, the settings modals.

</details>

---

## Quick start

### Prerequisites
- **Node.js ≥ 18** (uses ESM and the global `fetch` API)
- A **Strapi v5** instance with:
  - i18n enabled, with the locales you want (Polypost ships defaults for `en, zh, zh-Hant, ja, ko, de, fr, es, pt, ru, ar`)
  - A `blog` collection-type and a `category` collection-type (see [Customization](#customization))
  - The [`strapi-ai-translator`](https://www.npmjs.com/package/strapi-ai-translator) plugin installed and configured (this is what powers translation)
- An admin user account on your Strapi (used by Polypost to authenticate against the translator plugin and publish action)

### Install & run

```bash
git clone https://github.com/<your-username>/polypost.git
cd polypost
npm install
cp .env.example .env
# Edit .env (see Configuration below)
npm start
```

Open <http://localhost:4000> in **Chrome / Safari / Edge** (don't use file:// or sandboxed previews — those break relative `fetch` URLs).

---

## Configuration

Edit `.env`:

```env
# ===== Strapi connection =====
STRAPI_URL=https://your-strapi.example.com
# Settings → API Tokens → create one with "Full access" (or at minimum
# read/write on the blog collection + upload permission)
STRAPI_TOKEN=your-strapi-api-token

# ===== Strapi admin login =====
# Polypost auto-logs into Strapi admin to call the translator plugin and
# the Publish action. Use a real admin account.
STRAPI_ADMIN_EMAIL=you@example.com
STRAPI_ADMIN_PASSWORD=your-admin-password

# ===== Vision model (for auto-alt) — OPTIONAL =====
# Any OpenAI-compatible chat-completions endpoint with vision support.
# If left empty, image alts will be blank for you to fill in by hand.
VISION_API_BASE=https://api.atlascloud.ai/v1
VISION_API_KEY=your-vision-api-key
VISION_MODEL=qwen/qwen3-vl-30b-a3b-instruct

# ===== Review model (AI review on preview) — OPTIONAL =====
# Any OpenAI-compatible chat-completions endpoint.
# If REVIEW_API_BASE / REVIEW_API_KEY are empty, falls back to the
# VISION_* values above. If REVIEW_MODEL is empty, review is disabled.
REVIEW_API_BASE=
REVIEW_API_KEY=
REVIEW_MODEL=deepseek-ai/deepseek-v4-pro

# ===== Server =====
PORT=4000
```

Required vs optional:

| Variable                  | Required | Notes                                                            |
| ------------------------- | -------- | ---------------------------------------------------------------- |
| `STRAPI_URL`              | ✅       |                                                                  |
| `STRAPI_TOKEN`            | ✅       | Used for REST CRUD                                               |
| `STRAPI_ADMIN_EMAIL`      | ✅       | Used to log into admin and call the translator plugin            |
| `STRAPI_ADMIN_PASSWORD`   | ✅       |                                                                  |
| `VISION_*`                | optional | Without these, alts are blank but you can still fill them by hand |
| `REVIEW_*`                | optional | Without these, AI review on preview is skipped                   |
| `PORT`                    | optional | Defaults to `4000`                                               |

Vision and review model settings can **also** be configured from the web UI (top-right "⚙️ Vision model" / "⚙️ Review model" buttons). The UI settings are saved to `localStorage` per browser and override the `.env` defaults.

---

## How it works

### Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Browser (single-page UI)                          │
│   public/index.html — paste area, cover, fields, language, actions   │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ HTTP JSON
┌─────────────────────────────▼────────────────────────────────────────┐
│                    Polypost (Node + Express)                          │
│  server.js  – API endpoints                                           │
│  src/html.js          – HTML→Markdown, image extraction, YouTube tag  │
│  src/strapi.js        – Strapi REST: upload, create, PUT, publish     │
│  src/strapi-translate.js – Strapi admin login + translator plugin SSE │
│  src/vision.js        – OpenAI-compatible vision client (alt text)    │
│  src/review.js        – OpenAI-compatible text client (article check) │
│  src/pipeline.js      – Orchestration (prepare/translate/sync/publish)│
└─────────────┬───────────────────────────┬────────────────────────────┘
              │                           │
              │ REST API token            │ admin JWT
              │                           │
┌─────────────▼───────┐    ┌──────────────▼─────────────────┐
│  Strapi REST API    │    │  Strapi admin                  │
│  /api/blogs ...     │    │  /strapi-ai-translator/        │
│  /api/categories    │    │  /content-manager/.../publish  │
│  /api/upload        │    │                                │
└─────────────────────┘    └────────────────────────────────┘
```

### Stage diagram

```
PASTE
  │
  ▼
┌───────────────┐  Process article: parse HTML→MD, upload body images
│  📦 prepare    │  to Strapi CDN, upload cover, parse frontmatter,
│               │  generate alt text via vision model
└───────┬───────┘
        │
        ▼
ADJUST  widths and alts in the "Image widths" panel
        │
        ▼
┌───────────────┐  One translate call per non-en locale, in parallel,
│  🌐 translate │  via the strapi-ai-translator plugin's SSE endpoint.
│               │  Alt text is baked into the English source first so
└───────┬───────┘  every locale gets localized alts.
        │
        ▼
(Optional)  🧹 Clean format
        │
        ▼
┌───────────────┐  POST /api/blogs (en) + PUT /api/blogs/{id}?locale=xx
│  📤 sync       │  for every non-en locale. Image widths are written
│               │  into each locale's content here.
└───────┬───────┘
        │
        ▼
┌───────────────┐  POST /content-manager/.../actions/publish?locale=xx
│  🚀 publish   │  for every locale. Returns 1 clickable public URL per
│               │  locale.
└───────────────┘
```

### Authentication model

Polypost talks to two surfaces on Strapi:

1. **REST API** — using `STRAPI_TOKEN`. Used for creating/updating/reading blogs and uploading media. Token lifetime is whatever you set in Strapi.
2. **Admin** — using `STRAPI_ADMIN_EMAIL` / `STRAPI_ADMIN_PASSWORD`. Polypost logs in via `POST /admin/login` to obtain an admin JWT, which is required by:
   - The `strapi-ai-translator` plugin (the SSE translate endpoint).
   - The "Publish" action on a draft (`POST /content-manager/collection-types/.../actions/publish`).

The admin JWT is cached in-process. If it expires, Polypost detects the `401` and automatically re-logs in, then retries the request once.

---

## Detailed workflow

### Mode A — Publish a new article

1. **Mode** (top of page): keep `New article`.
2. **① Article content**: paste the article. Rich-text formatting (headings, bold, links, lists, tables, code blocks, images, YouTube embeds) is preserved.
3. **② Cover**: drag or click to upload a cover image. (Skip to auto-use the first body image.)
4. **③ Category & metadata**: pick a category card. Leave the optional override fields empty unless auto-detection mis-fires.
5. **④ Languages to publish**: check the locales you want.
6. **⑤ Actions** — click in order:
   - **📦 Process article** — uploads images, parses fields, generates alts. (~5–30 s)
   - In the **Image widths** panel: confirm AI-suggested alts, tweak widths if needed.
   - **🌐 Translate** — parallel translates the selected locales. (~5–15 s for 10 locales)
   - *(Optional)* **🧹 Clean format** — auto-fix common rendering quirks. Pushes to Strapi automatically if you've already synced.
   - **📤 Sync to Strapi** — creates the drafts. (~5–10 s)
   - **🚀 Publish all languages** — publishes everything and returns the public URLs. (~3–5 s)

### Mode B — Edit a published article

1. **Mode**: switch to `Edit existing (overwrite)`.
2. Paste the article's `documentId` or full Strapi admin URL → click **Load**.
3. Polypost loads:
   - All metadata fields → filled into the right inputs.
   - Existing body Markdown → rendered as editable HTML in the paste area.
   - Existing images → shown in the Image widths panel with their current widths and alts.
   - Existing locales → the language checkboxes are checked to match.
   - Existing cover → preview shown; left intact unless you upload a new one (fixed in this version).
4. Edit whatever you need to. Several common situations:
   - **Just edit a field** → change it directly, click `📤 Overwrite update`, then `🚀 Re-publish`. (Skip `Process` and `Translate`.)
   - **Replace the cover** → drop a new image, click `📤 Overwrite update`, then `🚀 Re-publish`.
   - **Edit body content** → modify the paste area, click `📦 Process` again, then re-translate and re-sync.
   - **Add a new locale** → check the box for the new locale, click `🌐 Translate`, then sync and publish.

---

## HTTP API reference

All endpoints accept and return JSON.

| Method | Path                  | Body                                                                | Returns                                                                                                 |
| ------ | --------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/meta`           | —                                                                   | `{ categories, locales }`                                                                               |
| POST   | `/api/preview-html`   | `{ html }`                                                          | `{ title, description, metaTitle, slug, markdown, imageCount, failedCount }`                            |
| POST   | `/api/review`         | `{ fields: {title,description,metaTitle,slug,content}, reviewConfig?}`  | `{ issues: [{type,description,location,original,fixed}], model }` (`{skipped:true}` if not configured)  |
| POST   | `/api/prepare`        | `{ html, overrides, coverDataUrl, existingCoverId?, visionConfig? }` | `{ enFields, coverId, imageCount, failedImageCount, images, visionEnabled }`                            |
| POST   | `/api/translate`      | `{ enFields, locales, imageAlts }`                                  | `{ enFields, translations, translatedLocales, failedTranslations }`                                     |
| POST   | `/api/sync`           | `{ enFields, translations, imageWidths }`                           | `{ documentId, synced: [{locale, ok, error?}] }`                                                        |
| POST   | `/api/update`         | `{ documentId, enFields, translations, imageWidths }`               | same as `/sync`                                                                                         |
| GET    | `/api/load-blog`      | query: `ref=<documentId or URL>`                                    | full article shape with `translations` of every existing locale                                         |
| POST   | `/api/publish-all`    | `{ documentId, locales, categoryDocId, slug }`                      | `{ documentId, results: [{locale, ok, url, error?}] }`                                                  |

CORS is open and serves are no-cache so a different origin (the in-tab preview panel of some IDEs) can talk to your local server.

---

## Project structure

```
.
├── server.js                  Express app + API routes (~3KB)
├── public/
│   └── index.html             Single-page UI: paste area, settings,
│                              actions, status, i18n, CSS, JS.
├── src/
│   ├── pipeline.js            Orchestration: prepare / translate /
│                              sync / update / publish + frontmatter
│                              parsing + format helpers.
│   ├── html.js                HTML→Markdown via node-html-markdown,
│                              image extraction & upload, YouTube tag
│                              detection, Lark placeholder cleanup.
│   ├── strapi.js              Strapi REST: uploadFile / createBlog /
│                              createLocalization / publishLocale /
│                              listCategories.
│   ├── strapi-translate.js    Strapi admin login (with auto-refresh
│                              on 401), translator plugin call,
│                              SSE response parser.
│   ├── vision.js              OpenAI-compatible vision client for
│                              alt-text generation.
│   ├── review.js              OpenAI-compatible text client for the
│                              AI article review.
│   └── convert.js             Legacy Lark docx→Markdown converter
│                              (not used by the current paste flow).
├── 用户文档.md                 Chinese-language user guide.
├── README.md                  This file.
├── .env.example               Template for .env.
├── .gitignore
├── LICENSE                    MIT.
└── package.json
```

---

## Customization

Polypost ships with defaults tuned for the Atlas Cloud blog, but is easy to adapt.

### Categories

Edit `CATEGORIES` in `src/pipeline.js`:

```js
export const CATEGORIES = [
  { docId: 'YOUR_CAT_DOCID_1', name: 'Guides',        path: 'guides',       hint: 'General tutorials' },
  { docId: 'YOUR_CAT_DOCID_2', name: 'Updates',       path: 'ai-updates',   hint: 'Model launches' },
  { docId: 'YOUR_CAT_DOCID_3', name: 'Case studies',  path: 'case-studies', hint: 'Comparisons' },
];
```

`docId` is the Strapi v5 `documentId` of your category entry. You can get it by listing your categories via the REST API. `path` is the URL segment used to build public URLs.

### Public URL template

Edit `buildPublicUrl` in `src/pipeline.js`. Default:

```
https://www.atlascloud.ai{/prefix}/blog/{categoryPath}/{slug}
```

`prefix` is empty for English and `/{locale}` for other locales, with one special case: `zh-Hant` → `/zh-TW`.

### Locales

Edit `URL_LOCALE_PREFIX` in `src/pipeline.js` to add/remove locales and adjust URL prefixes. The set must match your Strapi i18n configuration.

### Translator plugin

If you use a different Strapi translation plugin or write your own, replace the body of `src/strapi-translate.js`. The plugin only needs to expose:
- A way to translate `{title, description, metaTitle, content}` to a target locale.
- Authentication compatible with what your Strapi exposes.

### Vision / review models

Both are vanilla OpenAI-compatible chat-completions calls. You can point them at any provider (OpenAI, Anthropic via a compatible proxy, Atlas Cloud, etc.) by setting the relevant `*_API_BASE` / `*_API_KEY` / `*_MODEL` in `.env` or via the in-UI settings modals.

---

## Troubleshooting

| Symptom                                                      | Cause                                                       | Fix                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Failed to parse URL from /api/...`                          | Page opened from `file://` or an IDE preview panel          | Open `http://localhost:4000` in a real browser                                     |
| `admin login failed HTTP 400`                                | Wrong admin email/password in `.env`                        | Update `.env` and restart                                                          |
| `Translate HTTP 401`                                         | Cached admin JWT expired                                    | Polypost auto-retries; if it still fails, check admin login works manually         |
| `Create blog failed HTTP 400`                                | `category` was set to a numeric `id` instead of `documentId`| Polypost uses `documentId` already; if you customized, mirror that                 |
| `Publish failed HTTP 400/404`                                | Document doesn't exist or wasn't synced first               | Sync before publish                                                                |
| "X body images couldn't be uploaded"                         | Images live on an authenticated CDN (Lark)                  | Save each image locally and paste it directly into the paste area                  |
| Bare URL `https://api.example.com/...` rendered as blue link | CKEditor auto-links bare URLs                                | Click `🧹 Clean format`; Polypost inserts a ZWSP to defeat the URL auto-linker     |
| Table looks broken in Strapi                                 | Adjacent block has no blank line and the parser greedily extends the table | Click `🧹 Clean format`. Tables, HRs, fences and `<youtube>` get blank lines.      |
| Cover replaced by first body image after re-process          | Edit mode now correctly prefers `existingCoverId` over body's first image | Fixed in current version. Make sure you reload after pulling the latest code        |

---

## FAQ

**Q: Do I need OpenAI credits or another paid AI key to run this?**
Only if you want auto-generated alt text and the AI article review. Translation itself reuses your existing Strapi-side translator plugin, so the LLM cost there is what your Strapi already pays.

**Q: Can I publish to multiple Strapi instances?**
Not without a fork. Polypost currently reads a single `STRAPI_URL` per process. You can run multiple instances on different ports.

**Q: Will syncing overwrite manual edits done in Strapi?**
Yes. Sync is a PUT — it replaces the locale's content with what Polypost has in memory. If you've made manual edits to a specific locale and you don't want Polypost to overwrite them, don't re-translate or re-sync for that locale.

**Q: Why aren't tables (or weird block elements) rendering correctly?**
The Markdown rules around blank lines around block elements are strict. Always click `🧹 Clean format` before sync — it inserts the blank lines that the renderers actually require.

**Q: How does the AI review know what's a "real" mistake vs. a stylistic choice?**
It's prompted to flag exactly 10 categories of obvious authoring slips (leftover `H1:` prefix in a field, Lark export placeholders in the body, dangling escape backslashes, weird slugs with spaces, etc.) and to return strict JSON. It will not flag stylistic things like sentence length or tone.

**Q: How do I disable AI review entirely?**
Leave `REVIEW_API_BASE` / `REVIEW_API_KEY` / `REVIEW_MODEL` empty. Or open the ⚙️ Review model modal and clear the saved settings. Without configuration, clicking Preview just renders the Markdown, no AI call is made.

**Q: Why a custom favicon if it's an internal tool?**
The default Strapi-on-localhost favicon is the same one every Node web app uses; with several admin tabs open it's impossible to tell at a glance which one is Polypost. The custom icon takes ~0 bytes (inline SVG data URL) and is worth it.

---

## Roadmap

- [ ] Streaming progress for translate / publish (currently a single fire-and-forget per request).
- [ ] Bulk republish a list of articles (e.g. fix a typo across the whole blog).
- [ ] Optional GitHub-Action mode (publish a Markdown file from a PR).
- [ ] Move category / locale / public-URL templating into runtime config so the repo isn't fork-only for non-Atlas-Cloud users.
- [ ] Schema-detection: read the blog content-type fields at startup and auto-build the form.

---

## Contributing

PRs welcome. Easy first contributions:

- Add more language entries to the i18n dictionary (`I18N` object in `public/index.html`).
- Add support for more translator plugins in `src/strapi-translate.js`.
- Add more vision model presets to the dropdown.

For bigger changes (refactoring `pipeline.js`, changing the API shape, etc.), open an issue first to discuss.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Acknowledgments

- [Strapi](https://strapi.io/) — the headless CMS this entire tool exists for.
- [strapi-ai-translator](https://www.npmjs.com/package/strapi-ai-translator) — the translation plugin Polypost piggybacks on.
- [node-html-markdown](https://www.npmjs.com/package/node-html-markdown) — paste-area HTML to Markdown conversion.
- [marked](https://marked.js.org/) — Markdown back to HTML for the edit-mode preview area.
- [Atlas Cloud](https://www.atlascloud.ai/) — original deployment context and the default LLM provider (any OpenAI-compatible API works).
