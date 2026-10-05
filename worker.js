// Infographic Studio: the whole app (API + UI) in one Cloudflare Worker.
//
// Bindings (see wrangler.toml):
//   DB                 D1 database. Holds all data AND the image files (base64, split into <1 MB rows).
// Secrets / vars:
//   ANTHROPIC_API_KEY  Claude (writes and reviews prompts)
//   GEMINI_API_KEY     Nano Banana Pro (draws the images)
//   APP_PASSWORD       shared team password; empty = no login
//   CLAUDE_MODEL, GEMINI_IMAGE_MODEL, IMAGE_SIZE (1K default, see generateImageGemini)
//
// Background work (writing prompts, generating images, auto mode) runs inside the request that
// started it: the response is sent at once but kept open until the work is done, and the page
// polls for progress. Closing the tab stops that work; it is marked as interrupted after 10 min.

let ENV = {};

// ===========================================================================
// Database (D1)
// ===========================================================================
const SCHEMA = `
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  colors TEXT DEFAULT '',
  fonts TEXT DEFAULT '',
  tone TEXT DEFAULT '',
  dos TEXT DEFAULT '',
  donts TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  logo TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  details TEXT DEFAULT '',
  photos TEXT DEFAULT '[]',
  max_retries INTEGER DEFAULT 2,
  auto_mode TEXT DEFAULT 'off',
  auto_status TEXT DEFAULT 'idle',
  auto_message TEXT DEFAULT '',
  anchor_slot_id INTEGER,
  style_spec TEXT DEFAULT '',
  cancel INTEGER DEFAULT 0,
  beat TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  type TEXT DEFAULT 'features',
  brief TEXT DEFAULT '',
  status TEXT DEFAULT 'empty',
  message TEXT DEFAULT '',
  selected_prompt_id INTEGER,
  approved_image_id INTEGER,
  beat TEXT
);
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  label TEXT DEFAULT '',
  source TEXT DEFAULT 'variation',
  recommended INTEGER DEFAULT 0,
  batch TEXT,
  template_version TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  prompt_id INTEGER,
  path TEXT NOT NULL,
  qc TEXT,
  approved INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT NOT NULL,
  part INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (path, part)
)`;

let schemaReady = null;
const ensureSchema = () =>
  (schemaReady ||= ENV.DB.batch(SCHEMA.split(';').map((s) => ENV.DB.prepare(s.trim()))).catch((e) => {
    schemaReady = null;
    throw e;
  }));

const stmt = (sql, p) => ENV.DB.prepare(sql).bind(...p);
const all = async (sql, ...p) => (await stmt(sql, p).all()).results;
const get = (sql, ...p) => stmt(sql, p).first();
const run = (sql, ...p) => stmt(sql, p).run();
const now = () => new Date().toISOString();
const insertId = (r) => r.meta.last_row_id;

// A job whose tab was closed never finishes; flag it so the slot/product can be used again.
const STALE_MS = 10 * 60 * 1000;
async function reapStale() {
  const cut = new Date(Date.now() - STALE_MS).toISOString();
  await run(
    "UPDATE slots SET status='error', message='Interrupted (the browser tab was closed). Please try again.' WHERE status IN ('prompting','generating') AND (beat IS NULL OR beat < ?)",
    cut
  );
  await run(
    `UPDATE products SET auto_status='stopped', auto_message='Interrupted (the browser tab was closed).'
     WHERE auto_status='running' AND (beat IS NULL OR beat < ?)
       AND NOT EXISTS (SELECT 1 FROM slots WHERE product_id = products.id AND beat >= ?)`,
    cut,
    cut
  );
}

// ---------- files (stored in D1 as base64 text chunks; a D1 row is limited to 2 MB) ----------
const CHUNK = 1_000_000;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const mimeOf = (rel) => MIME[rel.split('.').pop().toLowerCase()] || 'application/octet-stream';

function toB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function saveFile(b64, ext, sub) {
  const rel = `${sub}/${crypto.randomUUID()}.${ext}`;
  const rows = [];
  for (let i = 0, part = 0; i < b64.length || part === 0; i += CHUNK, part++) {
    rows.push(ENV.DB.prepare('INSERT INTO files (path, part, data) VALUES (?,?,?)').bind(rel, part, b64.slice(i, i + CHUNK)));
  }
  for (const r of rows) await r.run(); // one by one: a batch of several MB is too big for one D1 request
  return rel;
}
async function readFile(rel) {
  const rows = await all('SELECT data FROM files WHERE path=? ORDER BY part', rel);
  if (!rows.length) throw new HttpError(404, 'File not found');
  return rows.map((r) => r.data).join('');
}
const deleteFile = (rel) => run('DELETE FROM files WHERE path=?', rel).catch(() => {});
// An image file as an API reference: { mime, data(base64) }.
const imageRef = async (rel) => ({ mime: mimeOf(rel), data: await readFile(rel) });

// Smallest possible ZIP writer (stored, no compression; the images are compressed already).
const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(u) {
  let c = ~0;
  for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
function zip(files) {
  const enc = new TextEncoder();
  const body = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const n = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true); // UTF-8 names
    h.setUint16(12, 0x21, true); // 1980-01-01
    h.setUint32(14, crc, true);
    h.setUint32(18, n, true);
    h.setUint32(22, n, true);
    h.setUint16(26, name.length, true);
    body.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(14, 0x21, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, n, true);
    c.setUint32(24, n, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + n;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, off, true);
  return new Blob([...body, ...central, new Uint8Array(e.buffer)]);
}

// ===========================================================================
// HTTP helpers
// ===========================================================================
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const errMsg = (e) => (e && e.message ? e.message : String(e));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Sends the response now and keeps it open while `job` runs (a space every 20 s keeps the
// connection alive). The page's api() helper does not wait for the body.
function background(job) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const ping = setInterval(() => w.write(enc.encode(' ')).catch(() => {}), 20000);
  (async () => {
    try {
      await job();
    } catch {
      /* jobs record their own errors on the slot/product */
    } finally {
      clearInterval(ping);
      await w.write(enc.encode('{"ok":true}')).catch(() => {});
      await w.close().catch(() => {});
    }
  })();
  return new Response(readable, { headers: { 'content-type': 'application/json', 'x-background': '1' } });
}
const jobResponse = (job) => (job ? background(job) : json({ ok: true }));

async function sessionToken(password) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('infographic-tool:' + password));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const cookie = (req, name) =>
  (req.headers.get('cookie') || '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

// ===========================================================================
// Templates
// ===========================================================================
const TEMPLATE_KEYS = ['variations', 'redo', 'style_spec', 'qc'];

const TEMPLATE_META = {
  variations: {
    title: 'Variation prompts',
    description:
      'How Claude writes the image-generation prompt variations for a slot. Also used for the single prompt per slot in auto mode.',
  },
  redo: {
    title: 'Redo prompt',
    description:
      'How Claude writes ONE new prompt after you press Redo (or after a failed automatic quality check). It sees the old prompt, your note and the generated image.',
  },
  style_spec: {
    title: 'Style spec (fine-tune mode)',
    description:
      'How Claude describes the approved anchor image so every other image in the product can match its style.',
  },
  qc: {
    title: 'Quality check',
    description:
      'What Claude looks for when it reviews a generated image (spelling, product match, layout, brand, claims).',
  },
};

const PLACEHOLDERS = [
  { name: 'brand_name', description: 'Brand name' },
  { name: 'brand_colors', description: 'Brand colors' },
  { name: 'brand_fonts', description: 'Brand fonts' },
  { name: 'brand_tone', description: 'Brand tone of voice' },
  { name: 'brand_dos', description: 'Brand "always do" rules' },
  { name: 'brand_donts', description: 'Brand "never do" rules' },
  { name: 'brand_notes', description: 'Other brand notes' },
  { name: 'product_name', description: 'Product name' },
  { name: 'product_details', description: 'Product details' },
  { name: 'slot_type', description: 'Type of this image (Features, Benefits, ...)' },
  { name: 'slot_type_guidance', description: 'Built-in guidance for that image type' },
  { name: 'slot_brief', description: 'The brief you wrote for this image' },
  { name: 'slot_position', description: 'Position of this image in the set (1, 2, ...)' },
  { name: 'total_slots', description: 'Number of infographic images for the product' },
  { name: 'other_slot_briefs', description: 'Briefs of the other images in the set' },
  { name: 'style_spec', description: 'Locked style description (fine-tune / auto mode)' },
  { name: 'variation_count', description: 'How many variations to write (3, or 1 in auto mode)' },
  { name: 'previous_prompt', description: 'Prompt that produced the current image (redo / quality check)' },
  { name: 'user_note', description: 'Your redo note, or the quality-check findings in auto retries' },
  { name: 'generated_prompt', description: 'Prompt used for the image being reviewed (quality check)' },
];

const SLOT_TYPES = {
  features: {
    label: 'Features',
    guidance:
      'Show the product clearly with 4 to 6 callouts that point at its key features. Each callout is a short title plus at most 6 words of support text.',
  },
  benefits: {
    label: 'Benefits',
    guidance:
      'Turn features into customer benefits using icons and short headlines. May show the product in use, but the product must stay accurate.',
  },
  dimensions: {
    label: 'Dimensions / size',
    guidance:
      'Show the product with dimension lines and labels. Use ONLY the measurements and units given in the brief or product details. Never invent a number.',
  },
  comparison: {
    label: 'Comparison',
    guidance:
      'Compare this product with a generic alternative in a simple two-column layout. Never name or show competitor brands.',
  },
  how_to_use: {
    label: 'How to use',
    guidance:
      'Show 3 or 4 numbered steps. Each step has a small visual, a short title and one short line. Keep the flow obvious left to right or top to bottom.',
  },
  whats_in_box: {
    label: "What's in the box",
    guidance:
      'Lay out every item included, neatly arranged, each with a clear label and quantity. Include only items listed in the brief or product details.',
  },
  other: {
    label: 'Other',
    guidance: 'Follow the brief closely and keep the layout clean, with a clear visual hierarchy.',
  },
};

// ---------------------------------------------------------------------------
// Default templates (editable in the app)
// ---------------------------------------------------------------------------
const DEFAULTS = {
  variations: `You are a senior Amazon listing designer and an expert prompt writer for AI image generation (Nano Banana Pro). Your prompts produce infographic images for the image gallery of an Amazon product listing.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Fonts: {{brand_fonts}}
- Tone of voice: {{brand_tone}}
- Always do: {{brand_dos}}
- Never do: {{brand_donts}}
- Other notes: {{brand_notes}}

PRODUCT
- Name: {{product_name}}
- Details: {{product_details}}

THIS IMAGE
- Position: image {{slot_position}} of {{total_slots}} in the infographic set
- Type: {{slot_type}}
- What this type needs: {{slot_type_guidance}}
- Brief from the team (follow it closely): {{slot_brief}}

THE OTHER INFOGRAPHICS IN THE SET (do not repeat their content)
{{other_slot_briefs}}

LOCKED STYLE
{{style_spec}}

YOUR TASK
Write {{variation_count}} prompt(s) for the image model. Each prompt must be complete and self-contained, because the image model sees nothing except the prompt and the reference photos.

RULES FOR EVERY PROMPT
1. Product fidelity: the real product photos are attached as reference images. Tell the image model to reproduce the product exactly as in the reference photos (shape, colors, parts, label, proportions) and never to invent, remove or alter features.
2. Canvas: a square 1:1 image, designed for an Amazon listing gallery. The product must be large and clearly the hero, and every element must stay inside safe margins so nothing is cut off.
3. Text on the image: write every word that must appear inside straight double quotes, exactly as it should be spelled. English only. Keep text short: headline of at most 6 words, callouts of at most 8 words. Ask for large, high-contrast, perfectly legible lettering.
4. Layout: describe the composition concretely, including background, where the product sits, where each callout, icon or number goes, the visual hierarchy, and how callouts connect to the product.
5. Brand: use the brand colors (give hex codes if known), the font style, and the logo if one is attached. Reproduce the logo exactly and do not redraw it.
6. Amazon safety: no unverifiable claims, no "#1", "best seller", "guaranteed" or medical claims, no competitor names, no prices, no review stars, no watermarks.
7. Variations: if a LOCKED STYLE is given, every variation must follow it exactly and may only differ in small layout details. If no style is locked, each variation must be a genuinely different concept (different layout, composition and background treatment), not a reworded copy.`,

  redo: `You are a senior Amazon listing designer and an expert prompt writer for AI image generation (Nano Banana Pro). An infographic image was generated and needs to be improved. Write ONE new, complete prompt that fixes the problems.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Fonts: {{brand_fonts}}
- Tone of voice: {{brand_tone}}
- Always do: {{brand_dos}}
- Never do: {{brand_donts}}

PRODUCT
- Name: {{product_name}}
- Details: {{product_details}}

THIS IMAGE
- Type: {{slot_type}} (image {{slot_position}} of {{total_slots}})
- Original brief: {{slot_brief}}

LOCKED STYLE
{{style_spec}}

PROMPT THAT PRODUCED THE CURRENT IMAGE
{{previous_prompt}}

WHAT NEEDS TO CHANGE
{{user_note}}

YOUR TASK
Look carefully at the generated image (the first attached image). Decide what is wrong or weak, using the notes above as the main guide, and write one new prompt that keeps what worked and fixes what did not. If the notes are empty, take a clearly fresh but better approach to the same brief.

The same rules apply as for any prompt: reproduce the product exactly as in the reference photos; keep a square 1:1 composition with safe margins; write every on-image word in straight double quotes, short, English and correctly spelled; describe the layout concretely; follow the brand; and avoid unverifiable claims. If a LOCKED STYLE is given, keep following it. The new prompt must be fully self-contained: do not refer to "the previous image" or "the old prompt".`,

  style_spec: `You are an art director. The attached image is an approved infographic for an Amazon listing. Write a style specification that another designer could follow to make more images that look like they belong to the same set, without copying this image's content.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Fonts: {{brand_fonts}}

Describe, in concrete and reusable terms:
1. Background (type, colors, gradients, textures, lighting)
2. Color usage (main, accent and text colors, with hex codes where you can tell)
3. Typography (font style, weights, sizes relative to the canvas, capitalization, alignment)
4. Product treatment (size on the canvas, angle, shadow, reflection, cut-out edge)
5. Callouts and icons (shape, line weight, fill, corner radius, how connectors are drawn)
6. Layout language (margins, grid, where headlines usually sit, spacing, density)
7. Overall mood and any recurring decorative elements

Be specific. Use at most 250 words. Do not describe the product itself or the specific words on this image.`,

  qc: `You are a strict quality reviewer for Amazon listing infographic images. The first attached image is the generated infographic to review. The other attached images are the real product photos and the brand logo.

BRAND
- Name: {{brand_name}}
- Colors: {{brand_colors}}
- Never do: {{brand_donts}}

PRODUCT
- Name: {{product_name}}
- Details: {{product_details}}

THIS IMAGE
- Type: {{slot_type}}
- Brief: {{slot_brief}}

PROMPT THAT WAS USED
{{generated_prompt}}

CHECK EACH OF THESE
1. Spelling and text: read every word on the image. Flag typos, garbled or cut-off words, wrong characters, and any text that differs from what the prompt asked for. Flag text that is too small or low-contrast to read on a phone.
2. Product fidelity: compare the product in the image with the reference photos. Flag a different shape, wrong colors, missing or extra parts, a changed label, distorted proportions, or invented features.
3. Layout: flag overlapping elements, anything cropped at the edges, unreadable or tiny text, clutter, unbalanced composition, a product that is too small, and connector lines that point at the wrong part.
4. Brand and compliance: flag a missing or redrawn logo, colors that clash with the brand, and risky claims ("#1", "best seller", "guaranteed", medical claims, competitor names, prices, review stars).
5. Numbers: if the image shows measurements or quantities, check they match the brief and product details.

Use severity "error" for anything that makes the image unusable for a listing (wrong product, misspelled text, cut-off content, wrong numbers, illegible text). Use "warning" for small issues that could be improved. Be honest and specific, and do not invent problems.`,
};

// Fixed part appended to every template. Shown in the editor but not editable,
// so one wrong edit cannot break the app.
const LOCKED = {
  variations: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with one JSON object and nothing else, with no markdown fences:
{"variations":[{"label":"2-4 word name for the concept","prompt":"the complete image-generation prompt"}],"recommended":0}
"variations" must contain exactly {{variation_count}} item(s). "recommended" is the 0-based index of the variation you expect to give the best Amazon-ready image.`,
  redo: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with one JSON object and nothing else, with no markdown fences:
{"prompt":"the complete new image-generation prompt"}`,
  style_spec: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with the style specification as plain text only. No preamble, no markdown headings.`,
  qc: `OUTPUT FORMAT (fixed by the app, do not change)
Reply with one JSON object and nothing else, with no markdown fences:
{"pass":true,"summary":"one sentence verdict","issues":[{"severity":"error","category":"spelling","message":"specific description of the problem"}]}
"category" is one of: spelling, product_fidelity, layout, brand, claims, other. "pass" must be false if there is at least one issue with severity "error". Use an empty "issues" array when the image is fine.`,
};

const latestTemplate = (scope, key) =>
  get('SELECT * FROM template_versions WHERE scope=? AND key=? ORDER BY version DESC LIMIT 1', scope, key);

// Brand override (if any) -> global edit (if any) -> built-in default.
async function getTemplate(key, brandId) {
  if (brandId) {
    const b = await latestTemplate('brand:' + brandId, key);
    if (b && b.content.trim()) {
      return { content: b.content, version: `brand:${brandId}:v${b.version}`, source: 'brand' };
    }
  }
  const g = await latestTemplate('global', key);
  if (g && g.content.trim()) {
    return { content: g.content, version: `global:v${g.version}`, source: 'global' };
  }
  return { content: DEFAULTS[key], version: 'default', source: 'default' };
}

async function saveTemplate(scope, key, content) {
  const last = await latestTemplate(scope, key);
  const version = (last ? last.version : 0) + 1;
  await run(
    'INSERT INTO template_versions (scope,key,content,version,created_at) VALUES (?,?,?,?,?)',
    scope,
    key,
    content,
    version,
    now()
  );
  return version;
}

const templateHistory = (scope, key) =>
  all(
    'SELECT version, content, created_at FROM template_versions WHERE scope=? AND key=? ORDER BY version DESC LIMIT 30',
    scope,
    key
  );

function unknownPlaceholders(content) {
  const known = new Set(PLACEHOLDERS.map((p) => p.name));
  const found = [...String(content).matchAll(/\{\{\s*([A-Za-z_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(found.filter((n) => !known.has(n)))];
}

function fillTemplate(content, vars) {
  return String(content).replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  );
}

function buildPrompt(key, content, vars, attachNote) {
  const attach = attachNote ? `\n\nATTACHED IMAGES\n${attachNote}` : '';
  return fillTemplate(`${content}${attach}\n\n${LOCKED[key]}`, vars);
}

// ===========================================================================
// AI: Claude (prompt writing and review) and Gemini (Nano Banana Pro images)
// ===========================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askClaude(text, images = [], maxTokens = 6000) {
  const key = ENV.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set. Add it as a secret in the Cloudflare dashboard.');
  const body = {
    model: ENV.CLAUDE_MODEL || 'claude-sonnet-5-5',
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
          { type: 'text', text },
        ],
      },
    ],
  };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
    const errText = (await res.text()).slice(0, 500);
    lastErr = new Error(`Claude API error ${res.status}: ${errText}`);
    if (![429, 500, 502, 503, 529].includes(res.status)) break;
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr;
}

function parseJson(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('Claude did not return JSON: ' + s.slice(0, 200));
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    throw new Error('Claude returned invalid JSON: ' + s.slice(0, 200));
  }
}

// Returns { data(base64), mime }. IMAGE_SIZE defaults to 1K: a 2K PNG can pass Claude's 5 MB
// per-image limit during the quality check, and there is no image library here to shrink it.
async function generateImageGemini(prompt, refs = []) {
  const key = ENV.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set. Add it as a secret in the Cloudflare dashboard.');
  const model = ENV.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.data } }))],
      },
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: ENV.IMAGE_SIZE || '1K' },
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const imgs = parts.filter((p) => (p.inlineData || p.inline_data) && !p.thought);
      const part = imgs[imgs.length - 1];
      if (!part) {
        const why =
          parts.map((p) => p.text).filter(Boolean).join(' ') ||
          data.promptFeedback?.blockReason ||
          data.candidates?.[0]?.finishReason ||
          'no image in the response';
        throw new Error('The image model returned no image: ' + String(why).slice(0, 300));
      }
      const d = part.inlineData || part.inline_data;
      return { data: d.data, mime: d.mimeType || d.mime_type || 'image/png' };
    }
    const errText = (await res.text()).slice(0, 500);
    lastErr = new Error(`Image API error ${res.status}: ${errText}`);
    if (![429, 500, 502, 503].includes(res.status)) break;
    await sleep(3000 * (attempt + 1));
  }
  throw lastErr;
}

// ===========================================================================
// Pipeline
// ===========================================================================
const BUSY = ['prompting', 'generating'];
const msgOf = (e) => (e && e.message) || String(e);
const val = (v) => (v && String(v).trim() ? String(v).trim() : '(not provided)');

const setSlot = (id, status, message = '') =>
  run('UPDATE slots SET status=?, message=?, beat=? WHERE id=?', status, message, now(), id);
const setAuto = (productId, status, message = '') =>
  run('UPDATE products SET auto_status=?, auto_message=?, beat=? WHERE id=?', status, message, now(), productId);
const isCancelled = async (productId) => (await get('SELECT cancel FROM products WHERE id=?', productId))?.cancel === 1;

async function loadCtx(slotId) {
  const slot = await get('SELECT * FROM slots WHERE id=?', slotId);
  if (!slot) throw new HttpError(404, 'Slot not found');
  const product = await get('SELECT * FROM products WHERE id=?', slot.product_id);
  const brand = await get('SELECT * FROM brands WHERE id=?', product.brand_id);
  const slots = await all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', product.id);
  return { slot, product, brand, slots };
}

function varsFor(ctx, extra = {}) {
  const { slot, product, brand, slots } = ctx;
  const type = SLOT_TYPES[slot.type] || SLOT_TYPES.other;
  const position = slots.findIndex((s) => s.id === slot.id) + 1;
  const others =
    slots
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.id !== slot.id)
      .map(({ s, i }) => `- Image ${i + 1} (${(SLOT_TYPES[s.type] || SLOT_TYPES.other).label}): ${s.brief || '(no brief yet)'}`)
      .join('\n') || '(none)';
  return {
    brand_name: val(brand.name),
    brand_colors: val(brand.colors),
    brand_fonts: val(brand.fonts),
    brand_tone: val(brand.tone),
    brand_dos: val(brand.dos),
    brand_donts: val(brand.donts),
    brand_notes: val(brand.notes),
    product_name: val(product.name),
    product_details: val(product.details),
    slot_type: type.label,
    slot_type_guidance: type.guidance,
    slot_brief: val(slot.brief),
    slot_position: position,
    total_slots: slots.length,
    other_slot_briefs: others,
    style_spec:
      product.style_spec && product.style_spec.trim()
        ? product.style_spec.trim()
        : 'None locked yet. Propose a strong style that fits the brand.',
    variation_count: '3',
    previous_prompt: '(none)',
    user_note: '(no note)',
    generated_prompt: '(none)',
    ...extra,
  };
}

// Product photos (and the logo) as reference images.
async function productRefs(product, brand) {
  const imgs = [];
  for (const p of JSON.parse(product.photos || '[]')) {
    try {
      imgs.push(await imageRef(p));
    } catch {
      /* skip unreadable file */
    }
  }
  const photoCount = imgs.length;
  let logo = false;
  if (brand.logo) {
    try {
      imgs.push(await imageRef(brand.logo));
      logo = true;
    } catch {
      /* skip */
    }
  }
  if (photoCount === 0) {
    throw new HttpError(400, 'Upload at least one real product photo first. The image model needs it to draw your actual product.');
  }
  return { imgs, photoCount, logo };
}

function describeRefs(refs, start = 1) {
  const lines = [];
  let n = start;
  if (refs.photoCount) {
    lines.push(
      refs.photoCount === 1
        ? `Image ${n}: a real photo of the product.`
        : `Images ${n}-${n + refs.photoCount - 1}: real photos of the product.`
    );
    n += refs.photoCount;
  }
  if (refs.logo) lines.push(`Image ${n}: the brand logo.`);
  return lines.join('\n');
}

// Instruction block placed in front of the prompt sent to the image model.
function imageModelNote(refs, hasStyleRef) {
  const lines = ['REFERENCE IMAGES ATTACHED (in order):'];
  let n = 1;
  if (refs.photoCount) {
    lines.push(
      (refs.photoCount === 1 ? `Image ${n} is` : `Images ${n}-${n + refs.photoCount - 1} are`) +
        ' real photo(s) of the product. Reproduce this exact product faithfully (shape, colors, parts, label, proportions). Never invent, remove or alter product features.'
    );
    n += refs.photoCount;
  }
  if (refs.logo) {
    lines.push(`Image ${n} is the brand logo. If a logo appears, reproduce it exactly.`);
    n += 1;
  }
  if (hasStyleRef) {
    lines.push(
      `Image ${n} is an approved infographic from the same set. Match its visual style (background, colors, fonts, icon style, layout language) but not its content.`
    );
  }
  lines.push('', 'IMAGE BRIEF:');
  return lines.join('\n');
}

const styleRefRow = (ctx) =>
  get(
    `SELECT i.* FROM images i JOIN slots s ON s.id = i.slot_id
     WHERE s.product_id = ? AND s.id <> ? AND i.approved = 1
     ORDER BY (s.id = ?) DESC, s.position ASC, s.id ASC LIMIT 1`,
    ctx.product.id,
    ctx.slot.id,
    ctx.product.anchor_slot_id || 0
  );

const selectedPrompt = (slot) =>
  slot.selected_prompt_id ? get('SELECT * FROM prompts WHERE id=?', slot.selected_prompt_id) : null;
const latestImage = (slotId) => get('SELECT * FROM images WHERE slot_id=? ORDER BY id DESC LIMIT 1', slotId);

async function insertPrompt(slotId, p) {
  return insertId(
    await run(
      'INSERT INTO prompts (slot_id,text,label,source,recommended,batch,template_version,created_at) VALUES (?,?,?,?,?,?,?,?)',
      slotId,
      p.text,
      p.label || '',
      p.source || 'variation',
      p.recommended ? 1 : 0,
      p.batch || null,
      p.templateVersion || null,
      now()
    )
  );
}

// ---------- Claude steps ----------
async function makeVariations(slotId, count = 3) {
  const ctx = await loadCtx(slotId);
  const tpl = await getTemplate('variations', ctx.brand.id);
  const refs = await productRefs(ctx.product, ctx.brand);
  const text = buildPrompt('variations', tpl.content, varsFor(ctx, { variation_count: String(count) }), describeRefs(refs));
  const parsed = parseJson(await askClaude(text, refs.imgs, 6000));
  const list = (Array.isArray(parsed.variations) ? parsed.variations : [])
    .filter((v) => v && typeof v.prompt === 'string' && v.prompt.trim())
    .slice(0, count);
  if (!list.length) throw new Error('Claude returned no usable prompt variations. Try again.');
  const rec =
    Number.isInteger(parsed.recommended) && parsed.recommended >= 0 && parsed.recommended < list.length ? parsed.recommended : 0;
  const batch = `b${Date.now()}`;
  const ids = [];
  for (const [i, v] of list.entries()) {
    ids.push(
      await insertPrompt(slotId, {
        text: v.prompt.trim(),
        label: v.label || `Variation ${i + 1}`,
        source: 'variation',
        recommended: i === rec,
        batch,
        templateVersion: tpl.version,
      })
    );
  }
  return { ids, recommendedId: ids[rec] };
}

async function makeRedoPrompt(slotId, note) {
  const ctx = await loadCtx(slotId);
  const prev = await selectedPrompt(ctx.slot);
  const last = await latestImage(slotId);
  const tpl = await getTemplate('redo', ctx.brand.id);
  const refs = await productRefs(ctx.product, ctx.brand);
  const imgs = [];
  let attach = '';
  if (last) {
    imgs.push(await imageRef(last.path));
    attach = 'Image 1: the generated image that needs improving.\n' + describeRefs(refs, 2);
  } else {
    attach = describeRefs(refs, 1);
  }
  imgs.push(...refs.imgs);
  const text = buildPrompt(
    'redo',
    tpl.content,
    varsFor(ctx, {
      previous_prompt: prev ? prev.text : '(none)',
      user_note: note && note.trim() ? note.trim() : '(no note: take a clearly fresh but better approach)',
    }),
    attach
  );
  const parsed = parseJson(await askClaude(text, imgs, 4000));
  if (!parsed.prompt || typeof parsed.prompt !== 'string') throw new Error('Claude returned no new prompt. Try again.');
  const id = await insertPrompt(slotId, {
    text: parsed.prompt.trim(),
    label: 'Redo',
    source: 'redo',
    templateVersion: tpl.version,
  });
  await run('UPDATE slots SET selected_prompt_id=? WHERE id=?', id, slotId);
  return id;
}

async function runQC(ctx, prompt, imagePath, refs) {
  const tpl = await getTemplate('qc', ctx.brand.id);
  const imgs = [await imageRef(imagePath), ...refs.imgs];
  const attach = 'Image 1: the generated infographic to review.\n' + describeRefs(refs, 2);
  const text = buildPrompt('qc', tpl.content, varsFor(ctx, { generated_prompt: prompt.text }), attach);
  const parsed = parseJson(await askClaude(text, imgs, 2000));
  const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .filter((i) => i && i.message)
    .map((i) => ({
      severity: i.severity === 'error' ? 'error' : 'warning',
      category: i.category || 'other',
      message: String(i.message),
    }));
  const hasError = issues.some((i) => i.severity === 'error');
  return { pass: !hasError, summary: String(parsed.summary || ''), issues };
}

async function makeStyleSpec(productId) {
  const product = await get('SELECT * FROM products WHERE id=?', productId);
  const brand = await get('SELECT * FROM brands WHERE id=?', product.brand_id);
  const anchor = product.anchor_slot_id
    ? await get('SELECT * FROM images WHERE slot_id=? AND approved=1 ORDER BY id DESC LIMIT 1', product.anchor_slot_id)
    : null;
  if (!anchor) throw new Error('The anchor image has not been approved yet.');
  const ctx = await loadCtx(product.anchor_slot_id);
  const tpl = await getTemplate('style_spec', brand.id);
  const text = buildPrompt('style_spec', tpl.content, varsFor(ctx), 'Image 1: the approved anchor infographic.');
  const spec = (await askClaude(text, [await imageRef(anchor.path)], 1500)).trim();
  if (!spec) throw new Error('Claude returned an empty style specification.');
  await run('UPDATE products SET style_spec=? WHERE id=?', spec, productId);
  return spec;
}

// ---------- image generation (+ automatic quality check) ----------
async function generateSlotImage(slotId) {
  const ctx = await loadCtx(slotId);
  const prompt = await selectedPrompt(ctx.slot);
  if (!prompt) throw new HttpError(400, 'Choose a prompt first.');
  await setSlot(slotId, 'generating', 'Generating image...');
  const refs = await productRefs(ctx.product, ctx.brand);
  const imgs = [...refs.imgs];
  const styleRow = await styleRefRow(ctx);
  if (styleRow) {
    try {
      imgs.push(await imageRef(styleRow.path));
    } catch {
      /* ignore */
    }
  }
  const out = await generateImageGemini(imageModelNote(refs, imgs.length > refs.imgs.length) + '\n' + prompt.text, imgs);
  const ext = out.mime.includes('jpeg') ? 'jpg' : out.mime.includes('webp') ? 'webp' : 'png';
  const rel = await saveFile(out.data, ext, 'images');
  const imageId = insertId(
    await run('INSERT INTO images (slot_id,prompt_id,path,created_at) VALUES (?,?,?,?)', slotId, prompt.id, rel, now())
  );

  await setSlot(slotId, 'generating', 'Checking quality...');
  let qc;
  try {
    qc = await runQC(ctx, prompt, rel, refs);
  } catch (e) {
    qc = { pass: null, summary: '', issues: [], error: 'Quality check could not run: ' + msgOf(e) };
  }
  await run('UPDATE images SET qc=? WHERE id=?', JSON.stringify(qc), imageId);
  await setSlot(slotId, 'review', '');
  return imageId;
}

async function approveImage(slotId, imageId) {
  const img = await get('SELECT * FROM images WHERE id=? AND slot_id=?', imageId, slotId);
  if (!img) throw new HttpError(404, 'Image not found for this slot');
  await run('UPDATE images SET approved=0 WHERE slot_id=?', slotId);
  await run('UPDATE images SET approved=1 WHERE id=?', imageId);
  await run('UPDATE slots SET approved_image_id=?, status=?, message=? WHERE id=?', imageId, 'approved', '', slotId);
}

// ---------- manual actions: validate, mark busy, and return the job to run in the background ----------
async function assertIdle(slotId) {
  const s = await get('SELECT status, product_id FROM slots WHERE id=?', slotId);
  if (!s) throw new HttpError(404, 'Slot not found');
  if (BUSY.includes(s.status)) throw new HttpError(409, 'This image is already being worked on.');
  const p = await get('SELECT auto_status FROM products WHERE id=?', s.product_id);
  if (p.auto_status === 'running') throw new HttpError(409, 'Auto mode is running for this product. Stop it first.');
}

async function startJob(slotId, status, message, fn) {
  await assertIdle(slotId);
  await setSlot(slotId, status, message);
  return () => fn().catch((e) => setSlot(slotId, 'error', msgOf(e)));
}

async function actVariations(slotId) {
  const { slot } = await loadCtx(slotId);
  if (!slot.brief || !slot.brief.trim()) throw new HttpError(400, 'Write a brief for this image first.');
  return startJob(slotId, 'prompting', 'Claude is writing 3 prompt variations...', async () => {
    await makeVariations(slotId, 3);
    await setSlot(slotId, 'choose', '');
  });
}

async function actChoose(slotId, promptId, text) {
  await assertIdle(slotId);
  const p = await get('SELECT * FROM prompts WHERE id=? AND slot_id=?', promptId, slotId);
  if (!p) throw new HttpError(404, 'Prompt not found for this slot');
  if (text && text.trim() && text.trim() !== p.text) {
    await run('UPDATE prompts SET text=? WHERE id=?', text.trim(), promptId);
  }
  await run('UPDATE slots SET selected_prompt_id=? WHERE id=?', promptId, slotId);
  return startJob(slotId, 'generating', 'Generating image...', () => generateSlotImage(slotId));
}

async function actGenerate(slotId) {
  const { slot } = await loadCtx(slotId);
  if (!slot.selected_prompt_id) throw new HttpError(400, 'Choose a prompt first.');
  return startJob(slotId, 'generating', 'Generating image...', () => generateSlotImage(slotId));
}

function actRedo(slotId, note) {
  return startJob(slotId, 'generating', 'Claude is writing a new prompt...', async () => {
    await makeRedoPrompt(slotId, note || '');
    await generateSlotImage(slotId);
  });
}

async function actApprove(slotId, imageId) {
  const { slot, product } = await loadCtx(slotId);
  if (BUSY.includes(slot.status)) throw new HttpError(409, 'Wait until this image has finished.');
  const id = imageId || (await latestImage(slotId))?.id;
  if (!id) throw new HttpError(400, 'There is no image to approve.');
  await approveImage(slotId, id);
  if (product.auto_status === 'awaiting_anchor' && product.anchor_slot_id === slotId) {
    await run('UPDATE products SET cancel=0 WHERE id=?', product.id);
    await setAuto(product.id, 'running', 'Reading the approved image to lock its style...');
    return () => continueAfterAnchor(product.id, false).catch((e) => setAuto(product.id, 'stopped', msgOf(e)));
  }
  return null;
}

// ---------- auto mode ----------
async function autoSlot(slotId) {
  const first = await loadCtx(slotId);
  const productId = first.product.id;
  const count = first.product.style_spec && first.product.style_spec.trim() ? 1 : 3;
  await setSlot(slotId, 'prompting', count === 1 ? 'Auto: writing the prompt...' : 'Auto: writing prompts and picking the best...');
  const { recommendedId } = await makeVariations(slotId, count);
  await run('UPDATE slots SET selected_prompt_id=? WHERE id=?', recommendedId, slotId);

  const maxRetries = Math.max(0, Number(first.product.max_retries) || 0);
  const qcOf = async (id) => JSON.parse((await get('SELECT qc FROM images WHERE id=?', id)).qc || 'null');
  let imageId = await generateSlotImage(slotId);
  let qc = await qcOf(imageId);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (!qc || qc.pass !== false) break; // passed, or the check could not run
    if (await isCancelled(productId)) break;
    const note =
      'The automatic quality check found these problems. Fix all of them:\n' +
      qc.issues.map((i) => `- [${i.severity}] ${i.category}: ${i.message}`).join('\n');
    await setSlot(slotId, 'generating', `Auto retry ${attempt}/${maxRetries}: fixing quality problems...`);
    await makeRedoPrompt(slotId, note);
    imageId = await generateSlotImage(slotId);
    qc = await qcOf(imageId);
  }

  if (qc && qc.pass === false) {
    await setSlot(slotId, 'review', 'Auto mode could not get this image through the quality check. Please review it.');
  } else {
    await approveImage(slotId, imageId);
  }
}

async function runAuto(productId, skipSlotId, force) {
  await setAuto(productId, 'running', 'Auto mode is running...');
  const slots = await all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', productId);
  const todo = slots.filter((s) => s.id !== skipSlotId && (force || s.status !== 'approved'));
  let n = 0;
  for (const s of todo) {
    if (await isCancelled(productId)) {
      await setAuto(productId, 'stopped', 'Stopped. The image that was in progress finished first.');
      return;
    }
    n += 1;
    await setAuto(productId, 'running', `Auto mode: image ${n} of ${todo.length}...`);
    try {
      await autoSlot(s.id);
    } catch (e) {
      await setSlot(s.id, 'error', msgOf(e));
    }
  }
  const after = await all('SELECT status FROM slots WHERE product_id=?', productId);
  const approved = after.filter((s) => s.status === 'approved').length;
  const review = after.filter((s) => s.status === 'review').length;
  const failed = after.filter((s) => s.status === 'error').length;
  const parts = [`${approved} approved`];
  if (review) parts.push(`${review} need your review`);
  if (failed) parts.push(`${failed} failed`);
  await setAuto(productId, 'done', `Auto mode finished: ${parts.join(', ')}.`);
}

async function continueAfterAnchor(productId, force) {
  await makeStyleSpec(productId);
  const product = await get('SELECT * FROM products WHERE id=?', productId);
  await runAuto(productId, product.anchor_slot_id, force);
}

async function validateAutoStart(productId) {
  const product = await get('SELECT * FROM products WHERE id=?', productId);
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.auto_status === 'running') throw new HttpError(409, 'Auto mode is already running.');
  const slots = await all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', productId);
  if (!slots.length) throw new HttpError(400, 'Add at least one image slot first.');
  if (slots.some((s) => BUSY.includes(s.status))) throw new HttpError(409, 'Wait until the current work has finished.');
  const missing = slots.findIndex((s) => !s.brief || !s.brief.trim());
  if (missing !== -1) throw new HttpError(400, `Write a brief for image ${missing + 1} first.`);
  if (!JSON.parse(product.photos || '[]').length) throw new HttpError(400, 'Upload at least one product photo first.');
  return { product, slots };
}

async function startAuto(productId, mode, anchorSlotId) {
  const { slots } = await validateAutoStart(productId);
  if (mode === 'full') {
    await run("UPDATE products SET auto_mode='full', cancel=0 WHERE id=?", productId);
    await setAuto(productId, 'running', 'Auto mode is starting...');
    return () => runAuto(productId, null, false).catch((e) => setAuto(productId, 'stopped', msgOf(e)));
  }
  if (mode === 'finetune') {
    const anchor = slots.find((s) => s.id === Number(anchorSlotId)) || slots[0];
    await run("UPDATE products SET auto_mode='finetune', anchor_slot_id=?, style_spec='', cancel=0 WHERE id=?", anchor.id, productId);
    if (anchor.status === 'approved') {
      await setAuto(productId, 'running', 'Reading the approved image to lock its style...');
      return () => continueAfterAnchor(productId, false).catch((e) => setAuto(productId, 'stopped', msgOf(e)));
    }
    await setAuto(
      productId,
      'awaiting_anchor',
      `Step 1: choose a prompt for image ${slots.indexOf(anchor) + 1} (the style anchor), generate it, redo until you like it, then press Approve. The other images follow automatically in that style.`
    );
    if (!anchor.selected_prompt_id || anchor.status === 'empty' || anchor.status === 'error') {
      return actVariations(anchor.id);
    }
    return null;
  }
  throw new HttpError(400, 'Unknown auto mode');
}

// Re-run every other image in the style of the current anchor (after the anchor changed).
async function restyleOthers(productId) {
  const product = await get('SELECT * FROM products WHERE id=?', productId);
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.auto_status === 'running') throw new HttpError(409, 'Auto mode is already running.');
  if (!product.anchor_slot_id) throw new HttpError(400, 'No style anchor is set for this product.');
  const anchor = await get('SELECT status FROM slots WHERE id=?', product.anchor_slot_id);
  if (!anchor || anchor.status !== 'approved') throw new HttpError(400, 'Approve the anchor image first.');
  await validateAutoStart(productId);
  await run('UPDATE products SET cancel=0 WHERE id=?', productId);
  await setAuto(productId, 'running', 'Reading the anchor image to lock its style...');
  return () => continueAfterAnchor(productId, true).catch((e) => setAuto(productId, 'stopped', msgOf(e)));
}

async function stopAuto(productId) {
  const product = await get('SELECT * FROM products WHERE id=?', productId);
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.auto_status === 'running') {
    await run('UPDATE products SET cancel=1, auto_message=? WHERE id=?', 'Stopping after the current step...', productId);
  } else if (product.auto_status === 'awaiting_anchor') {
    await setAuto(productId, 'idle', '');
  }
}

// ---------- read model for the UI ----------
async function getProductTree(productId) {
  const product = await get('SELECT * FROM products WHERE id=?', productId);
  if (!product) return null;
  const brand = await get('SELECT id, name FROM brands WHERE id=?', product.brand_id);
  const slotRows = await all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', productId);
  const ids = slotRows.map((s) => s.id).join(',') || '0'; // integer ids only, safe to inline
  const prompts = await all(`SELECT * FROM prompts WHERE slot_id IN (${ids}) ORDER BY id DESC`);
  const images = await all(`SELECT * FROM images WHERE slot_id IN (${ids}) ORDER BY id DESC`);
  const slots = slotRows.map((s) => ({
    ...s,
    prompts: prompts.filter((p) => p.slot_id === s.id),
    images: images.filter((i) => i.slot_id === s.id).map((i) => ({ ...i, qc: i.qc ? JSON.parse(i.qc) : null })),
  }));
  return { product: { ...product, photos: JSON.parse(product.photos || '[]') }, brand, slots };
}

// Settings page "Test": runs a draft variation template on a real slot without saving anything.
async function testVariationTemplate(slotId, content) {
  const ctx = await loadCtx(slotId);
  const refs = await productRefs(ctx.product, ctx.brand);
  const text = buildPrompt('variations', content, varsFor(ctx, { variation_count: '3' }), describeRefs(refs));
  const parsed = parseJson(await askClaude(text, refs.imgs, 6000));
  const list = (Array.isArray(parsed.variations) ? parsed.variations : []).filter((v) => v && v.prompt);
  if (!list.length) throw new Error('Claude returned no usable variations for this template.');
  return { variations: list, recommended: parsed.recommended ?? 0 };
}

// ===========================================================================
// API routes
// ===========================================================================
const routes = [];
const on = (method, pattern, fn) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn]);

const UPLOAD_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_PHOTOS = 3;
const MAX_SLOTS = 6;
const DEFAULT_SLOTS = ['features', 'benefits', 'dimensions', 'how_to_use'];
const clean = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'item';

on('POST', '/api/login', async (req) => {
  const password = ENV.APP_PASSWORD;
  const body = await req.json().catch(() => ({}));
  if (!password) return json({ ok: true });
  if (body.password !== password) return json({ error: 'Wrong password' }, 401);
  return json({ ok: true }, 200, {
    'set-cookie': `session=${await sessionToken(password)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
  });
});

on('GET', '/api/files/(?<path>.+)', async (req, { path }) => {
  const rel = decodeURIComponent(path);
  return new Response(fromB64(await readFile(rel)), {
    headers: { 'content-type': mimeOf(rel), 'cache-control': 'private, max-age=31536000, immutable' },
  });
});

// ---------- dashboard ----------
on('GET', '/api/dashboard', async () => {
  await reapStale();
  const brands = await all('SELECT id, name, logo FROM brands ORDER BY name COLLATE NOCASE');
  const products = await all('SELECT id, brand_id, name, photos, auto_status, created_at FROM products ORDER BY created_at DESC, id DESC');
  const rows = await all(
    `SELECT s.id AS slot_id, s.product_id, s.position, s.type, s.status, s.message,
       COALESCE(
         (SELECT path FROM images WHERE slot_id = s.id AND approved = 1 ORDER BY id DESC LIMIT 1),
         (SELECT path FROM images WHERE slot_id = s.id ORDER BY id DESC LIMIT 1)
       ) AS img
     FROM slots s ORDER BY s.product_id, s.position, s.id`
  );
  const recent = await all(
    `SELECT i.path, p.id AS product_id, p.name AS product
     FROM images i JOIN slots s ON s.id = i.slot_id JOIN products p ON p.id = s.product_id
     WHERE i.approved = 1 ORDER BY i.id DESC LIMIT 8`
  );

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }
  const brandName = new Map(brands.map((b) => [b.id, b.name]));

  const productList = products.map((p) => {
    const slots = byProduct.get(p.id) || [];
    const photos = JSON.parse(p.photos || '[]');
    return {
      id: p.id,
      brand_id: p.brand_id,
      brand: brandName.get(p.brand_id) || '',
      name: p.name,
      photo: photos[0] || null,
      auto_status: p.auto_status,
      slots: slots.map((s) => ({ id: s.slot_id, position: s.position, type: s.type, status: s.status })),
      total: slots.length,
      approved: slots.filter((s) => s.status === 'approved').length,
      thumbs: slots.map((s) => s.img).filter(Boolean).slice(0, 4),
    };
  });

  const brandList = brands.map((b) => {
    const mine = productList.filter((p) => p.brand_id === b.id);
    return {
      id: b.id,
      name: b.name,
      logo: b.logo,
      productCount: mine.length,
      slotCount: mine.reduce((n, p) => n + p.total, 0),
      approved: mine.reduce((n, p) => n + p.approved, 0),
      thumbs: mine.flatMap((p) => p.thumbs).slice(0, 4),
    };
  });

  const productById = new Map(productList.map((p) => [p.id, p]));
  const attention = rows
    .filter((r) => ['review', 'error', 'choose'].includes(r.status))
    .slice(0, 12)
    .map((r) => {
      const p = productById.get(r.product_id);
      return {
        slot_id: r.slot_id,
        product_id: r.product_id,
        product: p ? p.name : '',
        brand: p ? p.brand : '',
        position: r.position,
        type: r.type,
        status: r.status,
        message: r.message || '',
      };
    });

  const running =
    products.filter((p) => p.auto_status === 'running').length +
    rows.filter((r) => BUSY.includes(r.status)).length;

  return json({
    setup: { anthropic: !!ENV.ANTHROPIC_API_KEY, gemini: !!ENV.GEMINI_API_KEY, password: !!ENV.APP_PASSWORD },
    stats: {
      brands: brands.length,
      products: products.length,
      slots: rows.length,
      approved: rows.filter((r) => r.status === 'approved').length,
      attention: rows.filter((r) => ['review', 'error', 'choose'].includes(r.status)).length,
      running,
    },
    brands: brandList,
    products: productList,
    recent,
    attention,
  });
});

// ---------- brands ----------
on('GET', '/api/brands', async () => json({ brands: await all('SELECT * FROM brands ORDER BY name') }));

on('POST', '/api/brands', async (req) => {
  const body = await req.json();
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'Brand name is required');
  return json({ id: insertId(await run('INSERT INTO brands (name, created_at) VALUES (?, ?)', name, now())) });
});

const loadBrand = async (id) => {
  const brand = await get('SELECT * FROM brands WHERE id=?', Number(id));
  if (!brand) throw new HttpError(404, 'Brand not found');
  return brand;
};

on('GET', '/api/brands/:id', async (req, { id }) => json({ brand: await loadBrand(id) }));

on('PUT', '/api/brands/:id', async (req, { id }) => {
  const body = await req.json();
  const sets = [];
  const vals = [];
  for (const f of ['name', 'colors', 'fonts', 'tone', 'dos', 'donts', 'notes']) {
    if (typeof body[f] === 'string') {
      sets.push(`${f}=?`);
      vals.push(body[f]);
    }
  }
  if (body.name !== undefined && !String(body.name).trim()) throw new HttpError(400, 'Brand name is required');
  if (sets.length) await run(`UPDATE brands SET ${sets.join(', ')} WHERE id=?`, ...vals, Number(id));
  return json({ ok: true });
});

async function deleteProductFiles(p) {
  for (const f of JSON.parse(p.photos || '[]')) await deleteFile(f);
  for (const i of await all('SELECT i.path FROM images i JOIN slots s ON s.id=i.slot_id WHERE s.product_id=?', p.id)) {
    await deleteFile(i.path);
  }
}

on('DELETE', '/api/brands/:id', async (req, { id }) => {
  const brand = await loadBrand(id);
  for (const p of await all('SELECT * FROM products WHERE brand_id=?', brand.id)) await deleteProductFiles(p);
  if (brand.logo) await deleteFile(brand.logo);
  await run('DELETE FROM template_versions WHERE scope=?', 'brand:' + brand.id);
  await run('DELETE FROM brands WHERE id=?', brand.id);
  return json({ ok: true });
});

async function uploadedB64(file) {
  const ext = UPLOAD_EXT[file.type];
  if (!ext) throw new HttpError(400, 'Images must be PNG, JPG or WebP');
  return { ext, data: toB64(await file.arrayBuffer()) };
}

on('POST', '/api/brands/:id/logo', async (req, { id }) => {
  const brand = await loadBrand(id);
  const file = (await req.formData()).get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'No file uploaded');
  const { ext, data } = await uploadedB64(file);
  const rel = await saveFile(data, ext, 'logos');
  if (brand.logo) await deleteFile(brand.logo);
  await run('UPDATE brands SET logo=? WHERE id=?', rel, brand.id);
  return json({ logo: rel });
});

on('DELETE', '/api/brands/:id/logo', async (req, { id }) => {
  const brand = await loadBrand(id);
  if (brand.logo) await deleteFile(brand.logo);
  await run('UPDATE brands SET logo=NULL WHERE id=?', brand.id);
  return json({ ok: true });
});

// ---------- products ----------
on('POST', '/api/products', async (req) => {
  const body = await req.json();
  const name = String(body.name || '').trim();
  const brandId = Number(body.brand_id);
  if (!name) throw new HttpError(400, 'Product name is required');
  if (!(await get('SELECT id FROM brands WHERE id=?', brandId))) throw new HttpError(400, 'Brand not found');
  const id = insertId(await run('INSERT INTO products (brand_id, name, created_at) VALUES (?,?,?)', brandId, name, now()));
  for (const [i, type] of DEFAULT_SLOTS.entries()) {
    await run('INSERT INTO slots (product_id, position, type) VALUES (?,?,?)', id, i, type);
  }
  return json({ id });
});

on('GET', '/api/products/:id', async (req, { id }) => {
  await reapStale();
  const tree = await getProductTree(Number(id));
  if (!tree) throw new HttpError(404, 'Product not found');
  return json(tree);
});

on('PUT', '/api/products/:id', async (req, { id }) => {
  const body = await req.json();
  const sets = [];
  const vals = [];
  if (typeof body.name === 'string') {
    if (!body.name.trim()) throw new HttpError(400, 'Product name is required');
    sets.push('name=?');
    vals.push(body.name.trim());
  }
  if (typeof body.details === 'string') {
    sets.push('details=?');
    vals.push(body.details);
  }
  if (body.max_retries !== undefined) {
    sets.push('max_retries=?');
    vals.push(Math.max(0, Math.min(5, Number(body.max_retries) || 0)));
  }
  if (typeof body.style_spec === 'string') {
    sets.push('style_spec=?');
    vals.push(body.style_spec);
  }
  if (sets.length) await run(`UPDATE products SET ${sets.join(', ')} WHERE id=?`, ...vals, Number(id));
  return json({ ok: true });
});

on('DELETE', '/api/products/:id', async (req, { id }) => {
  const p = await get('SELECT * FROM products WHERE id=?', Number(id));
  if (!p) throw new HttpError(404, 'Product not found');
  if (p.auto_status === 'running') throw new HttpError(409, 'Stop auto mode first.');
  await deleteProductFiles(p);
  await run('DELETE FROM products WHERE id=?', p.id);
  return json({ ok: true });
});

on('GET', '/api/products/:id/export', async (req, { id }) => {
  const product = await get('SELECT * FROM products WHERE id=?', Number(id));
  if (!product) throw new HttpError(404, 'Product not found');
  const brand = await get('SELECT * FROM brands WHERE id=?', product.brand_id);
  const slots = await all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', product.id);

  const files = [];
  const notes = [];
  for (const s of slots) {
    // approved image if there is one, otherwise the newest
    const img =
      (await get('SELECT * FROM images WHERE slot_id=? AND approved=1 ORDER BY id DESC LIMIT 1', s.id)) ||
      (await get('SELECT * FROM images WHERE slot_id=? ORDER BY id DESC LIMIT 1', s.id));
    if (!img) continue;
    const ext = img.path.split('.').pop();
    const name = `${clean(brand.name)}_${clean(product.name)}_${String(files.length + 1).padStart(2, '0')}_${clean(s.type)}.${ext}`;
    files.push({ name, data: fromB64(await readFile(img.path)) });
    const prompt = img.prompt_id ? await get('SELECT text FROM prompts WHERE id=?', img.prompt_id) : null;
    notes.push(`${name}${img.approved ? '' : '  (not approved)'}\n${prompt ? prompt.text : ''}\n`);
  }
  if (!files.length) throw new HttpError(400, 'There are no generated images to export yet.');
  files.push({ name: 'prompts.txt', data: new TextEncoder().encode(notes.join('\n----\n\n')) });
  return new Response(zip(files), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${clean(brand.name)}_${clean(product.name)}.zip"`,
    },
  });
});

on('POST', '/api/products/:id/:action', async (req, { id, action }) => {
  const pid = Number(id);
  const product = await get('SELECT * FROM products WHERE id=?', pid);
  if (!product) throw new HttpError(404, 'Product not found');

  switch (action) {
    case 'photos': {
      const files = (await req.formData()).getAll('files').filter((f) => f && typeof f !== 'string');
      const photos = JSON.parse(product.photos || '[]');
      if (!files.length) throw new HttpError(400, 'No files uploaded');
      if (photos.length + files.length > MAX_PHOTOS) throw new HttpError(400, `A product can have at most ${MAX_PHOTOS} photos.`);
      for (const f of files) {
        const { ext, data } = await uploadedB64(f);
        photos.push(await saveFile(data, ext, 'uploads'));
      }
      await run('UPDATE products SET photos=? WHERE id=?', JSON.stringify(photos), pid);
      return json({ photos });
    }
    case 'delete-photo': {
      const { path } = await req.json();
      const photos = JSON.parse(product.photos || '[]');
      if (!photos.includes(path)) throw new HttpError(404, 'Photo not found');
      const left = photos.filter((p) => p !== path);
      await run('UPDATE products SET photos=? WHERE id=?', JSON.stringify(left), pid);
      await deleteFile(path);
      return json({ photos: left });
    }
    case 'add-slot': {
      const body = await req.json().catch(() => ({}));
      const { c } = await get('SELECT COUNT(*) c FROM slots WHERE product_id=?', pid);
      if (c >= MAX_SLOTS) throw new HttpError(400, `At most ${MAX_SLOTS} images per product.`);
      const pos = ((await get('SELECT MAX(position) m FROM slots WHERE product_id=?', pid)).m ?? -1) + 1;
      const slotId = insertId(
        await run('INSERT INTO slots (product_id, position, type, brief) VALUES (?,?,?,?)', pid, pos, body.type || 'other', body.brief || '')
      );
      return json({ id: slotId });
    }
    case 'auto-start': {
      const body = await req.json();
      return jobResponse(await startAuto(pid, body.mode, body.anchorSlotId));
    }
    case 'auto-stop':
      await stopAuto(pid);
      return json({ ok: true });
    case 'restyle':
      return jobResponse(await restyleOthers(pid));
    case 'reset-auto':
      if (product.auto_status === 'running') throw new HttpError(409, 'Stop auto mode first.');
      await run("UPDATE products SET auto_status='idle', auto_message='', auto_mode='off' WHERE id=?", pid);
      return json({ ok: true });
    default:
      throw new HttpError(404, 'Unknown action');
  }
});

// ---------- slots ----------
const loadSlot = async (id) => {
  const slot = await get('SELECT * FROM slots WHERE id=?', Number(id));
  if (!slot) throw new HttpError(404, 'Slot not found');
  return slot;
};

on('PUT', '/api/slots/:id', async (req, { id }) => {
  const slot = await loadSlot(id);
  const body = await req.json();
  if (typeof body.brief === 'string') await run('UPDATE slots SET brief=? WHERE id=?', body.brief, slot.id);
  if (typeof body.type === 'string') await run('UPDATE slots SET type=? WHERE id=?', body.type, slot.id);
  return json({ ok: true });
});

on('DELETE', '/api/slots/:id', async (req, { id }) => {
  const slot = await loadSlot(id);
  if (BUSY.includes(slot.status)) throw new HttpError(409, 'This image is being worked on.');
  for (const i of await all('SELECT path FROM images WHERE slot_id=?', slot.id)) await deleteFile(i.path);
  await run('DELETE FROM slots WHERE id=?', slot.id);
  return json({ ok: true });
});

on('POST', '/api/slots/:id/:action', async (req, { id, action }) => {
  const slotId = Number(id);
  const body = await req.json().catch(() => ({}));
  switch (action) {
    case 'variations':
      return jobResponse(await actVariations(slotId));
    case 'choose':
      return jobResponse(await actChoose(slotId, Number(body.promptId), body.text));
    case 'generate':
      return jobResponse(await actGenerate(slotId));
    case 'redo':
      return jobResponse(await actRedo(slotId, body.note));
    case 'approve':
      return jobResponse(await actApprove(slotId, body.imageId ? Number(body.imageId) : undefined));
    default:
      throw new HttpError(404, 'Unknown action');
  }
});

// ---------- prompt templates (shared by every user: stored in D1) ----------
async function parseScope(scope) {
  if (scope === 'global') return { scope, brandId: null };
  const m = /^brand:(\d+)$/.exec(scope || '');
  if (!m || !(await get('SELECT id FROM brands WHERE id=?', Number(m[1])))) throw new HttpError(400, 'Unknown scope');
  return { scope, brandId: Number(m[1]) };
}

on('GET', '/api/templates', async (req) => {
  const scope = new URL(req.url).searchParams.get('scope') || 'global';
  const { brandId } = await parseScope(scope);
  const templates = {};
  for (const key of TEMPLATE_KEYS) {
    const eff = await getTemplate(key, brandId);
    templates[key] = {
      ...TEMPLATE_META[key],
      content: eff.content,
      source: eff.source, // default | global | brand
      version: eff.version,
      overridden: brandId ? eff.source === 'brand' : eff.source === 'global',
      locked: LOCKED[key],
      history: await templateHistory(scope, key),
      warnings: unknownPlaceholders(eff.content),
    };
  }
  return json({
    scope,
    templates,
    placeholders: PLACEHOLDERS,
    brands: await all('SELECT id, name FROM brands ORDER BY name'),
    testTargets: await all(
      `SELECT s.id, s.position, s.type, p.name AS product, b.name AS brand
       FROM slots s JOIN products p ON p.id = s.product_id JOIN brands b ON b.id = p.brand_id
       WHERE p.photos <> '[]' ORDER BY b.name, p.name, s.position`
    ),
  });
});

on('PUT', '/api/templates', async (req) => {
  const { scope, key, content } = await req.json();
  await parseScope(scope);
  if (!TEMPLATE_KEYS.includes(key)) throw new HttpError(400, 'Unknown template');
  const text = String(content ?? '');
  if (scope === 'global' && !text.trim()) throw new HttpError(400, 'The template cannot be empty. Use "Reset to default" instead.');
  return json({ version: await saveTemplate(scope, key, text), warnings: unknownPlaceholders(text) });
});

on('POST', '/api/templates', async (req) => {
  const body = await req.json();
  if (body.action === 'reset') {
    await parseScope(body.scope);
    if (!TEMPLATE_KEYS.includes(body.key)) throw new HttpError(400, 'Unknown template');
    // global: save the built-in default as a new version (history is kept)
    // brand: save an empty version, which means "inherit the global template"
    return json({ version: await saveTemplate(body.scope, body.key, body.scope === 'global' ? DEFAULTS[body.key] : '') });
  }
  if (body.action === 'test') {
    if (!String(body.content || '').trim()) throw new HttpError(400, 'The template is empty.');
    return json(await testVariationTemplate(Number(body.slotId), String(body.content)));
  }
  throw new HttpError(400, 'Unknown action');
});

// ===========================================================================
// UI (the React app, compiled from the original Next.js components; React comes from esm.sh)
// ===========================================================================
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Infographic Studio</title>
<meta name="description" content="Internal tool for creating Amazon listing infographic images" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400..700&display=swap" />
<link rel="stylesheet" href="/app.css" />
<script type="importmap">
{ "imports": {
  "react": "https://esm.sh/react@19.1.0",
  "react/jsx-runtime": "https://esm.sh/react@19.1.0/jsx-runtime",
  "react-dom/client": "https://esm.sh/react-dom@19.1.0/client?deps=react@19.1.0"
} }
</script>
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>`;

const CSS = `:root {
  --ink: #0c2227;
  --ink-2: #143036;
  --pine: #14575b;
  --pine-d: #0e4246;
  --pine-l: #e3f0ef;
  --saffron: #f2a93b;
  --saffron-d: #dd9526;
  --paper: #f2f5f4;
  --surface: #ffffff;
  --line: #dde5e4;
  --line-2: #ebf0ef;
  --text: #12262a;
  --muted: #5c7175;
  --faint: #8da0a3;
  --ok: #1c7c54;
  --ok-bg: #e1f3ea;
  --warn: #9a5b00;
  --warn-bg: #fff0d3;
  --err: #b42318;
  --err-bg: #fde9e7;
  --r-sm: 6px;
  --r-md: 10px;
  --r-lg: 16px;
  --print: 4px;
  --f-display: 'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif;
  --f-body: 'Figtree', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --shadow: 0 1px 2px rgba(12, 34, 39, 0.05), 0 14px 30px -16px rgba(12, 34, 39, 0.28);
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--text);
  font: 15px/1.55 var(--f-body);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { font-family: var(--f-display); margin: 0; letter-spacing: -0.012em; line-height: 1.15; }
h1 { font-size: 30px; font-weight: 650; }
h2 { font-size: 19px; font-weight: 620; }
h3 { font-size: 15.5px; font-weight: 620; }
p { margin: 0; }
a { color: var(--pine); text-decoration: none; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; background: var(--line-2); padding: 1px 5px; border-radius: 4px; }
:focus-visible { outline: 2px solid var(--saffron); outline-offset: 2px; }

.muted { color: var(--muted); }
.small { font-size: 13px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.row.top { align-items: flex-start; }
.grow { flex: 1; min-width: 0; }
.stack > * + * { margin-top: 14px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }

/* ---------- forms ---------- */
label.field { display: block; font-size: 13.5px; font-weight: 600; margin-bottom: 6px; color: #2b4348; }
input[type='text'], input[type='password'], input[type='number'], select, textarea {
  width: 100%; padding: 9px 12px; font: inherit; color: var(--text);
  border: 1px solid #c9d6d5; border-radius: var(--r-md); background: #fff;
  transition: border-color 0.15s, box-shadow 0.15s;
}
textarea { resize: vertical; min-height: 76px; line-height: 1.5; }
textarea.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--pine); box-shadow: 0 0 0 3px rgba(20, 87, 91, 0.16); }
select.select-sm { width: auto; padding: 6px 30px 6px 10px; font-weight: 600; font-size: 14px; }
input::placeholder, textarea::placeholder { color: #94a7a9; }

/* ---------- buttons ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  font: 600 14px/1 var(--f-body); padding: 10px 16px; border-radius: 9px;
  border: 1px solid transparent; cursor: pointer; white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
a.btn:hover { text-decoration: none; }
.btn-primary { background: var(--pine); color: #fff; }
.btn-primary:hover { background: var(--pine-d); }
.btn-accent { background: var(--saffron); color: #2a1b00; }
.btn-accent:hover { background: var(--saffron-d); }
.btn-quiet { background: var(--surface); border-color: var(--line); color: var(--text); }
.btn-quiet:hover { border-color: var(--pine); color: var(--pine); }
.btn-ghost { background: transparent; color: var(--muted); }
.btn-ghost:hover { background: var(--line-2); color: var(--text); }
.btn-light { background: rgba(255, 255, 255, 0.08); color: #fff; border-color: rgba(255, 255, 255, 0.18); }
.btn-light:hover { background: rgba(255, 255, 255, 0.15); }
.btn-danger { background: var(--surface); border-color: #ebc5c0; color: var(--err); }
.btn-danger:hover { background: var(--err-bg); }
.btn-sm { padding: 7px 11px; font-size: 13px; border-radius: 8px; }
.btn:disabled, .btn[aria-disabled='true'] { opacity: 0.5; cursor: not-allowed; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
.icon-btn:hover { background: var(--line-2); color: var(--text); }
.filebtn { cursor: pointer; }
.filebtn input { display: none; }

/* ---------- badges, banners, dots ---------- */
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--line-2); color: #3e5559; white-space: nowrap; }
.badge.ok { background: var(--ok-bg); color: var(--ok); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.err { background: var(--err-bg); color: var(--err); }
.badge.busy { background: var(--pine-l); color: var(--pine); }

.banner { padding: 11px 15px; border-radius: var(--r-md); margin-bottom: 14px; font-size: 14px; }
.banner.err { background: var(--err-bg); color: var(--err); }
.banner.warn { background: var(--warn-bg); color: var(--warn); }
.banner.info { background: var(--pine-l); color: var(--pine-d); }
.banner.ok { background: var(--ok-bg); color: var(--ok); }
.banner.row { gap: 10px; }

.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: #c6d4d3; flex: none; }
.dot[data-s='approved'], .dot[data-s='approved-ok'] { background: var(--ok); }
.dot[data-s='review'], .dot[data-s='choose'] { background: var(--saffron); }
.dot[data-s='error'] { background: var(--err); }
.dot[data-s='prompting'], .dot[data-s='generating'] { background: var(--pine); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }

.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #b9d3d2; border-top-color: var(--pine); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: -2px; margin-right: 8px; }
@keyframes spin { to { transform: rotate(360deg); } }

.meter { height: 6px; border-radius: 99px; background: var(--line-2); overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--saffron); border-radius: 99px; transition: width 0.4s; }

/* ---------- app shell ---------- */
.app { display: grid; grid-template-columns: 268px minmax(0, 1fr); min-height: 100vh; }
.sidebar { background: var(--ink); color: #b9cfce; position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; padding: 22px 14px 16px; overflow-y: auto; }
.brandmark { display: flex; align-items: center; gap: 11px; padding: 2px 8px 24px; color: #fff; font-family: var(--f-display); font-weight: 650; font-size: 17px; letter-spacing: -0.01em; }
.brandmark:hover { text-decoration: none; }
.nav-link { display: flex; align-items: center; gap: 11px; padding: 9px 10px; border-radius: 9px; color: #b9cfce; font-weight: 500; position: relative; }
.nav-link:hover { background: rgba(255, 255, 255, 0.06); color: #fff; text-decoration: none; }
.nav-link.active { background: rgba(255, 255, 255, 0.1); color: #fff; }
.nav-link.active::before { content: ''; position: absolute; left: -14px; top: 9px; bottom: 9px; width: 3px; border-radius: 0 3px 3px 0; background: var(--saffron); }
.nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-count { font-size: 12px; color: #7f9c9c; }
.nav-title { display: flex; align-items: center; justify-content: space-between; padding: 24px 10px 8px; color: #7f9c9c; font-size: 13px; font-weight: 600; }
.nav-title .icon-btn { color: #7f9c9c; width: 26px; height: 26px; }
.nav-title .icon-btn:hover { background: rgba(255, 255, 255, 0.08); color: #fff; }
.nav-empty { padding: 4px 10px; font-size: 13.5px; color: #7f9c9c; }
.sidebar-foot { margin-top: auto; padding: 16px 10px 0; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 13px; display: grid; gap: 7px; }
.svc { display: flex; align-items: center; gap: 9px; color: #9fb8b7; }
.mobilebar { display: none; }
.scrim-side { display: none; }
.main { min-width: 0; }
.page { max-width: 1280px; margin: 0 auto; padding: 30px 40px 90px; }

/* ---------- page header, crumbs, tabs ---------- */
.crumbs { display: flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--muted); margin-bottom: 14px; flex-wrap: wrap; }
.crumbs a { color: var(--muted); }
.crumbs a:hover { color: var(--pine); }
.crumbs span.cur { color: var(--text); font-weight: 600; }
.page-head { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; margin-bottom: 22px; }
.page-head .grow { min-width: 220px; }
.page-head p { margin-top: 4px; }
.thumb-lg { width: 66px; height: 66px; border-radius: 14px; border: 1px solid var(--line); background: #fff; overflow: hidden; display: flex; align-items: center; justify-content: center; flex: none; color: var(--faint); }
.thumb-lg img { width: 100%; height: 100%; object-fit: contain; }
.avatar { width: 40px; height: 40px; border-radius: 11px; background: var(--pine-l); color: var(--pine); display: flex; align-items: center; justify-content: center; font: 650 18px var(--f-display); flex: none; overflow: hidden; border: 1px solid var(--line-2); }
.avatar img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
.avatar.lg { width: 66px; height: 66px; border-radius: 16px; font-size: 28px; }
.seg { display: inline-flex; background: #e4ebea; border-radius: 11px; padding: 3px; gap: 2px; margin-bottom: 22px; }
.seg button { border: 0; background: transparent; padding: 8px 16px; border-radius: 8px; font: 600 14px var(--f-body); color: var(--muted); cursor: pointer; }
.seg button:hover { color: var(--text); }
.seg button.on { background: #fff; color: var(--text); box-shadow: 0 1px 2px rgba(12, 34, 39, 0.1); }

/* ---------- dashboard ---------- */
.hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 430px); gap: 40px; align-items: center; background: var(--ink); color: #fff; border-radius: 22px; padding: 36px 38px; }
.hero h1 { font-size: 38px; color: #fff; max-width: 15em; font-weight: 640; }
.hero p { color: #a9c3c2; margin-top: 12px; max-width: 48ch; font-size: 16px; }
.hero-actions { display: flex; gap: 10px; margin-top: 26px; flex-wrap: wrap; }
.sheet { background: #071719; padding: 10px; border-radius: 13px; border: 1px solid rgba(255, 255, 255, 0.08); }
.sheet-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.sheet-tile { aspect-ratio: 1; border-radius: var(--print); overflow: hidden; background: #12313a; display: block; }
.sheet-tile img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.25s; }
a.sheet-tile:hover img { transform: scale(1.06); }
.sheet-tile.empty { background: transparent; border: 1px dashed rgba(255, 255, 255, 0.14); }
.sheet-cap { color: #7f9c9c; font-size: 12.5px; padding: 9px 3px 1px; }

.statband { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); margin-top: 18px; }
.stat { padding: 18px 24px; border-left: 1px solid var(--line); }
.stat:first-child { border-left: 0; }
.stat b { display: block; font: 650 30px/1.1 var(--f-display); letter-spacing: -0.02em; }
.stat span { color: var(--muted); font-size: 13.5px; }
.stat .meter { margin-top: 9px; }

.dash-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 30px; margin-top: 34px; align-items: start; }
.sec-head { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; flex-wrap: wrap; }
.search { position: relative; width: 290px; max-width: 100%; }
.search svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--faint); }
.search input { padding-left: 34px; padding-top: 7px; padding-bottom: 7px; }

.folders { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 32px 20px; padding-top: 14px; }
.folder { position: relative; display: block; color: inherit; }
.folder:hover { text-decoration: none; }
.folder-tab { position: absolute; left: 0; top: -13px; height: 14px; width: 84px; background: var(--surface); border: 1px solid var(--line); border-bottom: 0; border-radius: 9px 9px 0 0; transition: border-color 0.15s; z-index: 1; }
.folder-body { background: var(--surface); border: 1px solid var(--line); border-radius: 0 15px 15px 15px; padding: 16px; transition: border-color 0.15s, box-shadow 0.15s; }
.folder:hover .folder-body { border-color: #aec5c4; box-shadow: var(--shadow); }
.folder:hover .folder-tab { border-color: #aec5c4; }
.folder-head { display: flex; align-items: center; gap: 12px; }
.folder-name { font: 620 16.5px var(--f-display); letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 15px 0 14px; }
.folder-thumbs img, .folder-thumbs .ph { aspect-ratio: 1; width: 100%; border-radius: 3px; object-fit: cover; display: block; background: var(--line-2); }
.folder-foot { margin-top: 8px; color: var(--muted); font-size: 13px; }
.folder.new .folder-body { border-style: dashed; background: transparent; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 196px; color: var(--muted); font-weight: 600; cursor: pointer; width: 100%; font-family: inherit; font-size: 15px; }
.folder.new .folder-tab { background: transparent; border-style: dashed; }
.folder.new:hover .folder-body { color: var(--pine); border-color: var(--pine); box-shadow: none; }
button.folder { background: none; border: 0; padding: 0; text-align: left; font: inherit; cursor: pointer; width: 100%; }

.pgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 18px; }
.pcard { display: block; background: var(--surface); border: 1px solid var(--line); border-radius: 15px; overflow: hidden; color: inherit; transition: border-color 0.15s, box-shadow 0.15s; }
.pcard:hover { text-decoration: none; border-color: #aec5c4; box-shadow: var(--shadow); }
.pcard-media { aspect-ratio: 1 / 0.82; background: #e9efee; display: flex; align-items: center; justify-content: center; color: var(--faint); overflow: hidden; }
.pcard-media img.photo { width: 100%; height: 100%; object-fit: contain; background: #fff; padding: 14px; }
.collage { width: 100%; height: 100%; display: grid; gap: 2px; }
.collage.c1 { grid-template-columns: 1fr; }
.collage.c2 { grid-template-columns: 1fr 1fr; }
.collage.c3, .collage.c4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.collage img { width: 100%; height: 100%; object-fit: cover; display: block; min-height: 0; }
.pcard-body { padding: 13px 15px 15px; }
.pcard-title { font: 620 16px var(--f-display); letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pcard-sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
.pcard-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 11px; }
.dots { display: flex; gap: 5px; }
.pcard.new { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 250px; border-style: dashed; background: transparent; color: var(--muted); font: 600 15px var(--f-body); cursor: pointer; width: 100%; }
.pcard.new:hover { color: var(--pine); border-color: var(--pine); box-shadow: none; }

.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 20px 22px; }
.panel + .panel { margin-top: 16px; }
.panel > h2, .panel > .panel-head { margin-bottom: 14px; }
.panel-head { display: flex; align-items: center; gap: 10px; }
.arow { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-top: 1px solid var(--line-2); color: inherit; }
.arow:first-of-type { border-top: 0; }
.arow:hover { text-decoration: none; }
.arow:hover .arow-title { color: var(--pine); }
.arow-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { border: 1.5px dashed #bfd0cf; border-radius: var(--r-lg); padding: 34px 24px; text-align: center; color: var(--muted); }
.empty h3 { color: var(--text); margin-bottom: 6px; }
.empty .btn { margin-top: 16px; }
.skeleton { background: linear-gradient(90deg, #e6edec 0%, #f3f7f6 50%, #e6edec 100%); background-size: 200% 100%; animation: sheen 1.4s linear infinite; border-radius: var(--r-lg); height: 220px; }
@keyframes sheen { to { background-position: -200% 0; } }

/* ---------- product workspace ---------- */
.strip { display: flex; gap: 12px; margin: 0 0 26px; overflow-x: auto; padding-bottom: 4px; }
.tile { flex: 0 0 132px; color: inherit; }
.tile:hover { text-decoration: none; }
.tile-img { aspect-ratio: 1; border-radius: var(--print); border: 1px solid var(--line); background: #fff; overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--faint); font: 650 22px var(--f-display); transition: border-color 0.15s; }
.tile:hover .tile-img { border-color: var(--pine); }
.tile-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tile-cap { display: flex; align-items: center; gap: 7px; margin-top: 7px; font-size: 13px; color: var(--muted); }

.workspace { display: grid; grid-template-columns: minmax(0, 1fr) 350px; gap: 24px; align-items: start; }
.ws-main > * + * { margin-top: 18px; }

.slot { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; scroll-margin-top: 20px; }
.slot-top { display: flex; align-items: center; gap: 12px; padding: 13px 18px; border-bottom: 1px solid var(--line-2); background: #fafcfb; flex-wrap: wrap; }
.slot-num { width: 30px; height: 30px; border-radius: 50%; background: var(--ink); color: #fff; display: flex; align-items: center; justify-content: center; font: 650 14px var(--f-display); flex: none; }
.slot-body { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 22px; padding: 20px 18px; }
.frame { aspect-ratio: 1; border-radius: var(--print); border: 1px solid var(--line); background: #f4f7f6; overflow: hidden; display: flex; align-items: center; justify-content: center; position: relative; }
.frame img.generated { width: 100%; height: 100%; object-fit: cover; display: block; }
.frame-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--faint); font-size: 13.5px; text-align: center; padding: 18px; }
.frame.loading::after { content: ''; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.7) 50%, transparent 70%); background-size: 220% 100%; animation: sheen 1.3s linear infinite; }
.thumbs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.thumbs img { width: 56px; height: 56px; object-fit: cover; border-radius: 3px; border: 2px solid var(--line); cursor: pointer; background: #fff; }
.thumbs img.sel { border-color: var(--pine); }
.thumbs img.appr { outline: 2px solid var(--ok); outline-offset: 1px; }
.slot-variations { grid-column: 1 / -1; border-top: 1px solid var(--line-2); padding-top: 20px; }
.variations { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 14px; margin-top: 12px; }
.variation { border: 1px solid var(--line); border-radius: 13px; padding: 14px; background: #fbfcfc; }
.variation.rec { border-color: var(--saffron); background: #fffaf0; }
.variation textarea { min-height: 190px; font-size: 13px; }
.slot-variations .variations { grid-template-columns: minmax(0, 1fr); }
.slot-variations .variation textarea { min-height: 130px; }
.redo { border: 1px solid var(--line); border-radius: 13px; padding: 14px 16px; background: #fafcfb; }
.qc { font-size: 14px; }
.qc ul { margin: 8px 0 0; padding-left: 18px; }
.qc li.error { color: var(--err); }
.qc li.warning { color: var(--warn); }
details.prompt-details summary { cursor: pointer; font-size: 13.5px; color: var(--muted); font-weight: 600; }
.locked { background: #f1f5f4; border: 1px dashed #bccbca; border-radius: 10px; padding: 11px 13px; white-space: pre-wrap; color: #50676b; }

.photos { display: flex; gap: 10px; flex-wrap: wrap; }
.photo { position: relative; width: 92px; height: 92px; border: 1px solid var(--line); border-radius: 11px; overflow: hidden; background: #fff; }
.photo img { width: 100%; height: 100%; object-fit: contain; }
.photo button { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border-radius: 6px; border: 0; background: rgba(12, 34, 39, 0.7); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
.photo button:hover { background: var(--err); }

.choice { display: flex; gap: 11px; align-items: flex-start; padding: 12px 13px; border: 1px solid var(--line); border-radius: 12px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.choice input { margin-top: 4px; accent-color: var(--pine); }
.choice b { display: block; font-weight: 650; }
.choice small { color: var(--muted); font-size: 13px; display: block; line-height: 1.4; }
.choice.on { border-color: var(--pine); background: var(--pine-l); }

/* ---------- templates ---------- */
.tpl { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 24px; align-items: start; }
.rail { display: grid; gap: 4px; }
.rail button { text-align: left; border: 0; background: transparent; padding: 10px 13px; border-radius: 10px; font: 600 14.5px var(--f-body); color: var(--muted); cursor: pointer; }
.rail button:hover { background: var(--line-2); color: var(--text); }
.rail button.on { background: var(--surface); color: var(--text); box-shadow: inset 3px 0 0 var(--saffron), 0 0 0 1px var(--line); }
.chip { display: inline-block; padding: 3px 9px; margin: 3px 4px 3px 0; border-radius: 7px; background: var(--line-2); font-family: ui-monospace, Menlo, monospace; font-size: 12px; cursor: pointer; border: 1px solid #d7e1e0; color: #2d4549; }
.chip:hover { background: var(--pine-l); border-color: #b8d4d2; }

/* ---------- modal ---------- */
.scrim { position: fixed; inset: 0; background: rgba(7, 23, 25, 0.55); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 20px; animation: fade 0.12s ease-out; }
.modal { background: #fff; border-radius: 18px; width: min(440px, 100%); padding: 22px 24px 24px; box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.5); animation: pop 0.16s ease-out; }
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { opacity: 0; transform: translateY(8px) scale(0.98); } }

/* ---------- login ---------- */
.login { min-height: 100vh; display: grid; place-items: center; background: var(--ink); padding: 20px; }
.login-card { background: #fff; border-radius: 20px; padding: 32px; width: min(390px, 100%); }
.login-card .brandmark { color: var(--ink); padding: 0 0 22px; }

/* ---------- responsive ---------- */
@media (max-width: 1100px) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  .ws-side { order: -1; }
  .dash-grid { grid-template-columns: minmax(0, 1fr); }
  .hero { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .app { display: block; }
  .sidebar { position: fixed; left: 0; top: 0; width: 280px; transform: translateX(-100%); transition: transform 0.2s; z-index: 50; }
  .sidebar.open { transform: none; }
  .scrim-side { display: block; position: fixed; inset: 0; background: rgba(7, 23, 25, 0.5); z-index: 45; }
  .mobilebar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--ink); color: #fff; position: sticky; top: 0; z-index: 30; font: 650 16px var(--f-display); }
  .mobilebar .icon-btn { color: #fff; }
  .page { padding: 20px 16px 80px; }
  .hero { padding: 26px 22px; }
  .hero h1 { font-size: 29px; }
  .statband { grid-template-columns: repeat(2, 1fr); }
  .stat:nth-child(3) { border-left: 0; }
  .stat:nth-child(n + 3) { border-top: 1px solid var(--line); }
  .slot-body { grid-template-columns: minmax(0, 1fr); }
  .tpl { grid-template-columns: minmax(0, 1fr); }
  .rail { grid-auto-flow: column; overflow-x: auto; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;

const APP_JS = `// app/main.js
import { createRoot } from "react-dom/client";

// shims/router.js
import { createElement, useSyncExternalStore } from "react";
var listeners = /* @__PURE__ */ new Set();
var notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);
var subscribe = (l) => (listeners.add(l), () => listeners.delete(l));
function navigate(url, replace) {
  history[replace ? "replaceState" : "pushState"](null, "", url);
  window.scrollTo(0, 0);
  notify();
}
var useUrl = () => useSyncExternalStore(subscribe, () => location.pathname + location.search);
var usePathname = () => useSyncExternalStore(subscribe, () => location.pathname);
var useRouter = () => ({ push: (u) => navigate(u), replace: (u) => navigate(u, true), refresh() {
} });
function Link({ href, onClick, ...rest }) {
  return createElement("a", {
    href,
    ...rest,
    onClick(e) {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(href);
    }
  });
}

// app/Shell.js
import { useEffect as useEffect3, useState as useState3 } from "react";

// app/DashboardContext.js
import { createContext, useCallback, useContext, useEffect as useEffect2, useState as useState2 } from "react";

// app/api-client.js
async function shrink(file, max = 1568) {
  if (!/^image\\/(png|jpeg|webp)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d");
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  if (type === "image/jpeg") {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
  }
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, type, 0.88));
  return new File([blob], file.name.replace(/\\.\\w+$/, "") + (type === "image/png" ? ".png" : ".jpg"), { type });
}
async function api(url, options = {}) {
  const opts = { ...options };
  if (opts.body instanceof FormData) {
    const form = new FormData();
    for (const [k, v] of opts.body) form.append(k, v instanceof File ? await shrink(v) : v);
    opts.body = form;
  } else if (opts.body) {
    opts.headers = { "content-type": "application/json", ...opts.headers || {} };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  if (res.ok && res.headers.get("x-background")) {
    res.text().catch(() => {
    });
    return { ok: true };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
  }
  if (res.status === 401 && location.pathname !== "/login") location.href = "/login";
  if (!res.ok) throw new Error(data && data.error || \`Request failed (\${res.status})\`);
  return data;
}

// app/ui.js
import { useEffect, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var PATHS = {
  home: /* @__PURE__ */ jsx("path", { d: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" }),
  folder: /* @__PURE__ */ jsx("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }),
  image: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }),
    /* @__PURE__ */ jsx("circle", { cx: "9", cy: "10", r: "1.6" }),
    /* @__PURE__ */ jsx("path", { d: "M21 16l-5-5-8 8" })
  ] }),
  plus: /* @__PURE__ */ jsx("path", { d: "M12 5v14M5 12h14" }),
  search: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("circle", { cx: "11", cy: "11", r: "6.5" }),
    /* @__PURE__ */ jsx("path", { d: "M20 20l-4-4" })
  ] }),
  sliders: /* @__PURE__ */ jsx("path", { d: "M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" }),
  check: /* @__PURE__ */ jsx("path", { d: "M5 12.5l4.5 4.5L19 7.5" }),
  chevron: /* @__PURE__ */ jsx("path", { d: "M9 6l6 6-6 6" }),
  menu: /* @__PURE__ */ jsx("path", { d: "M4 7h16M4 12h16M4 17h16" }),
  x: /* @__PURE__ */ jsx("path", { d: "M6 6l12 12M18 6L6 18" }),
  download: /* @__PURE__ */ jsx("path", { d: "M12 4v11M7 10.5l5 5 5-5M5 20h14" }),
  alert: /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("path", { d: "M12 4l9 16H3z" }),
    /* @__PURE__ */ jsx("path", { d: "M12 10v4M12 17.2v.1" })
  ] })
};
function Icon({ name, size = 18 }) {
  return /* @__PURE__ */ jsx("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: PATHS[name] });
}
function Mark({ size = 30 }) {
  return /* @__PURE__ */ jsxs("svg", { width: size, height: size, viewBox: "0 0 32 32", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsx("rect", { x: "2", y: "9", width: "17", height: "17", rx: "4", fill: "#14575b", stroke: "#2c8a8f", strokeWidth: "1.4" }),
    /* @__PURE__ */ jsx("rect", { x: "8", y: "5", width: "17", height: "17", rx: "4", fill: "#1d7a7f", stroke: "#4aa9ad", strokeWidth: "1.4" }),
    /* @__PURE__ */ jsx("rect", { x: "14", y: "1.5", width: "16", height: "16", rx: "4", fill: "#f2a93b" })
  ] });
}
var STATUS = {
  empty: ["", "Not started"],
  prompting: ["busy", "Writing prompts"],
  choose: ["warn", "Choose a prompt"],
  generating: ["busy", "Generating"],
  review: ["warn", "Review image"],
  approved: ["ok", "Approved"],
  error: ["err", "Error"]
};
var TYPE_OPTIONS = [
  ["features", "Features"],
  ["benefits", "Benefits"],
  ["dimensions", "Dimensions / size"],
  ["comparison", "Comparison"],
  ["how_to_use", "How to use"],
  ["whats_in_box", "What's in the box"],
  ["other", "Other"]
];
var TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS);
function StatusDot({ status }) {
  return /* @__PURE__ */ jsx("span", { className: "dot", "data-s": status, title: (STATUS[status] || ["", status])[1] });
}
function Avatar({ name, logo, large }) {
  return /* @__PURE__ */ jsx("span", { className: \`avatar \${large ? "lg" : ""}\`, children: logo ? /* @__PURE__ */ jsx("img", { src: \`/api/files/\${logo}\`, alt: "" }) : (name || "?").trim().charAt(0).toUpperCase() });
}
function Crumbs({ items }) {
  return /* @__PURE__ */ jsx("nav", { className: "crumbs", "aria-label": "Breadcrumb", children: items.map((it, i) => /* @__PURE__ */ jsxs("span", { className: "row", style: { gap: 6 }, children: [
    i > 0 && /* @__PURE__ */ jsx(Icon, { name: "chevron", size: 13 }),
    it.href ? /* @__PURE__ */ jsx(Link, { href: it.href, children: it.label }) : /* @__PURE__ */ jsx("span", { className: "cur", children: it.label })
  ] }, i)) });
}
function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return /* @__PURE__ */ jsx("div", { className: "scrim", onMouseDown: (e) => e.target === e.currentTarget && onClose(), children: /* @__PURE__ */ jsxs("div", { className: "modal", role: "dialog", "aria-modal": "true", "aria-label": title, children: [
    /* @__PURE__ */ jsxs("div", { className: "modal-head", children: [
      /* @__PURE__ */ jsx("h2", { children: title }),
      /* @__PURE__ */ jsx("button", { className: "icon-btn", onClick: onClose, "aria-label": "Close", children: /* @__PURE__ */ jsx(Icon, { name: "x" }) })
    ] }),
    children
  ] }) });
}
function NameModal({ title, label, placeholder, cta, onSubmit, onClose }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return /* @__PURE__ */ jsx(Modal, { title, onClose, children: /* @__PURE__ */ jsxs("form", { onSubmit: submit, className: "stack", children: [
    /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("label", { className: "field", htmlFor: "name-modal-input", children: label }),
      /* @__PURE__ */ jsx("input", { id: "name-modal-input", type: "text", autoFocus: true, value: name, placeholder, onChange: (e) => setName(e.target.value) })
    ] }),
    error && /* @__PURE__ */ jsx("div", { className: "banner err", children: error }),
    /* @__PURE__ */ jsxs("div", { className: "modal-actions", children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "btn btn-quiet", onClick: onClose, children: "Cancel" }),
      /* @__PURE__ */ jsx("button", { type: "submit", className: "btn btn-primary", disabled: busy || !name.trim(), children: busy ? "Creating..." : cta })
    ] })
  ] }) });
}

// app/DashboardContext.js
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var Ctx = createContext(null);
function DashboardProvider({ children }) {
  const [data, setData] = useState2(null);
  const [error, setError] = useState2("");
  const [brandModal, setBrandModal] = useState2(false);
  const pathname = usePathname();
  const router = useRouter();
  const refresh = useCallback(async () => {
    try {
      setData(await api("/api/dashboard"));
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect2(() => {
    refresh();
  }, [refresh, pathname]);
  const live = !!data && data.stats.running > 0;
  useEffect2(() => {
    if (!live) return void 0;
    const t = setInterval(refresh, 3e3);
    return () => clearInterval(t);
  }, [live, refresh]);
  const value = { data, error, refresh, openNewBrand: () => setBrandModal(true) };
  return /* @__PURE__ */ jsxs2(Ctx.Provider, { value, children: [
    children,
    brandModal && /* @__PURE__ */ jsx2(
      NameModal,
      {
        title: "New brand folder",
        label: "Brand name",
        placeholder: "e.g. Acme Outdoors",
        cta: "Create brand",
        onClose: () => setBrandModal(false),
        onSubmit: async (name) => {
          const { id } = await api("/api/brands", { method: "POST", body: { name } });
          await refresh();
          setBrandModal(false);
          router.push(\`/brands/\${id}\`);
        }
      }
    )
  ] });
}
var useDashboard = () => useContext(Ctx);

// app/Shell.js
import { jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function Shell({ children }) {
  const pathname = usePathname();
  if (pathname === "/login") return children;
  return /* @__PURE__ */ jsx3(DashboardProvider, { children: /* @__PURE__ */ jsx3(Frame, { pathname, children }) });
}
function Frame({ pathname, children }) {
  const { data, openNewBrand } = useDashboard();
  const [open, setOpen] = useState3(false);
  useEffect3(() => {
    setOpen(false);
  }, [pathname]);
  const brands = data?.brands || [];
  const setup = data?.setup;
  const cls = (active) => \`nav-link \${active ? "active" : ""}\`;
  return /* @__PURE__ */ jsxs3("div", { className: "app", children: [
    /* @__PURE__ */ jsxs3("div", { className: "mobilebar", children: [
      /* @__PURE__ */ jsx3("button", { className: "icon-btn", "aria-label": "Open menu", onClick: () => setOpen(true), children: /* @__PURE__ */ jsx3(Icon, { name: "menu", size: 22 }) }),
      /* @__PURE__ */ jsx3("span", { children: "Infographic Studio" })
    ] }),
    /* @__PURE__ */ jsxs3("aside", { className: \`sidebar \${open ? "open" : ""}\`, children: [
      /* @__PURE__ */ jsxs3(Link, { href: "/", className: "brandmark", children: [
        /* @__PURE__ */ jsx3(Mark, {}),
        /* @__PURE__ */ jsx3("span", { children: "Infographic Studio" })
      ] }),
      /* @__PURE__ */ jsxs3("nav", { children: [
        /* @__PURE__ */ jsxs3(Link, { href: "/", className: cls(pathname === "/"), children: [
          /* @__PURE__ */ jsx3(Icon, { name: "home" }),
          /* @__PURE__ */ jsx3("span", { className: "nav-label", children: "Dashboard" })
        ] }),
        /* @__PURE__ */ jsxs3(Link, { href: "/settings/templates", className: cls(pathname.startsWith("/settings")), children: [
          /* @__PURE__ */ jsx3(Icon, { name: "sliders" }),
          /* @__PURE__ */ jsx3("span", { className: "nav-label", children: "Prompt templates" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "nav-title", children: [
        /* @__PURE__ */ jsx3("span", { children: "Brand folders" }),
        /* @__PURE__ */ jsx3("button", { className: "icon-btn", onClick: openNewBrand, "aria-label": "New brand folder", title: "New brand folder", children: /* @__PURE__ */ jsx3(Icon, { name: "plus", size: 16 }) })
      ] }),
      /* @__PURE__ */ jsxs3("nav", { children: [
        brands.map((b) => /* @__PURE__ */ jsxs3(Link, { href: \`/brands/\${b.id}\`, className: cls(pathname === \`/brands/\${b.id}\`), children: [
          /* @__PURE__ */ jsx3(Icon, { name: "folder" }),
          /* @__PURE__ */ jsx3("span", { className: "nav-label", children: b.name }),
          /* @__PURE__ */ jsx3("span", { className: "nav-count", children: b.productCount })
        ] }, b.id)),
        data && brands.length === 0 && /* @__PURE__ */ jsx3("p", { className: "nav-empty", children: "No brands yet." })
      ] }),
      /* @__PURE__ */ jsxs3("div", { className: "sidebar-foot", children: [
        /* @__PURE__ */ jsxs3("div", { className: "svc", title: setup && !setup.anthropic ? "Add ANTHROPIC_API_KEY to .env.local" : "Claude writes and reviews prompts", children: [
          /* @__PURE__ */ jsx3("span", { className: "dot", "data-s": setup ? setup.anthropic ? "approved" : "error" : "" }),
          "Claude ",
          setup && !setup.anthropic ? "key missing" : "connected"
        ] }),
        /* @__PURE__ */ jsxs3("div", { className: "svc", title: setup && !setup.gemini ? "Add GEMINI_API_KEY to .env.local" : "Nano Banana Pro draws the images", children: [
          /* @__PURE__ */ jsx3("span", { className: "dot", "data-s": setup ? setup.gemini ? "approved" : "error" : "" }),
          "Nano Banana Pro ",
          setup && !setup.gemini ? "key missing" : "connected"
        ] })
      ] })
    ] }),
    open && /* @__PURE__ */ jsx3("div", { className: "scrim-side", onClick: () => setOpen(false) }),
    /* @__PURE__ */ jsx3("main", { className: "main", children })
  ] });
}

// app/login/Login.js
import { useState as useState4 } from "react";
import { jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
function Login() {
  const [password, setPassword] = useState4("");
  const [error, setError] = useState4("");
  const [busy, setBusy] = useState4(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { method: "POST", body: { password } });
      window.location.href = "/";
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return /* @__PURE__ */ jsx4("div", { className: "login", children: /* @__PURE__ */ jsxs4("form", { className: "login-card stack", onSubmit: submit, children: [
    /* @__PURE__ */ jsxs4("div", { className: "brandmark", children: [
      /* @__PURE__ */ jsx4(Mark, { size: 34 }),
      /* @__PURE__ */ jsx4("span", { children: "Infographic Studio" })
    ] }),
    /* @__PURE__ */ jsxs4("div", { children: [
      /* @__PURE__ */ jsx4("h1", { style: { fontSize: 24 }, children: "Sign in" }),
      /* @__PURE__ */ jsx4("p", { className: "muted small", style: { marginTop: 4 }, children: "Enter the team password to open the studio." })
    ] }),
    /* @__PURE__ */ jsxs4("div", { children: [
      /* @__PURE__ */ jsx4("label", { className: "field", htmlFor: "pw", children: "Team password" }),
      /* @__PURE__ */ jsx4("input", { id: "pw", type: "password", autoFocus: true, value: password, onChange: (e) => setPassword(e.target.value) })
    ] }),
    error && /* @__PURE__ */ jsx4("div", { className: "banner err", children: error }),
    /* @__PURE__ */ jsx4("button", { type: "submit", className: "btn btn-primary", style: { width: "100%" }, disabled: busy || !password, children: busy ? "Checking..." : "Sign in" })
  ] }) });
}

// app/DashboardClient.js
import { useState as useState5 } from "react";

// app/ProductCard.js
import { jsx as jsx5, jsxs as jsxs5 } from "react/jsx-runtime";
function ProductCard({ p, showBrand }) {
  const n = p.thumbs.length;
  const attention = p.slots.filter((s) => s.status === "review" || s.status === "error" || s.status === "choose").length;
  return /* @__PURE__ */ jsxs5(Link, { href: \`/products/\${p.id}\`, className: "pcard", children: [
    /* @__PURE__ */ jsx5("div", { className: "pcard-media", children: n > 0 ? /* @__PURE__ */ jsx5("div", { className: \`collage c\${n}\`, children: p.thumbs.map((t) => /* @__PURE__ */ jsx5("img", { src: \`/api/files/\${t}\`, alt: "", loading: "lazy" }, t)) }) : p.photo ? /* @__PURE__ */ jsx5("img", { className: "photo", src: \`/api/files/\${p.photo}\`, alt: "", loading: "lazy" }) : /* @__PURE__ */ jsx5(Icon, { name: "image", size: 34 }) }),
    /* @__PURE__ */ jsxs5("div", { className: "pcard-body", children: [
      /* @__PURE__ */ jsx5("div", { className: "pcard-title", children: p.name }),
      /* @__PURE__ */ jsxs5("div", { className: "pcard-sub", children: [
        showBrand ? \`\${p.brand}: \` : "",
        p.approved,
        " of ",
        p.total,
        " approved"
      ] }),
      /* @__PURE__ */ jsxs5("div", { className: "pcard-foot", children: [
        /* @__PURE__ */ jsx5("div", { className: "dots", children: p.slots.map((s) => /* @__PURE__ */ jsx5(StatusDot, { status: s.status }, s.id)) }),
        p.auto_status === "running" ? /* @__PURE__ */ jsx5("span", { className: "badge busy", children: "Auto running" }) : attention > 0 ? /* @__PURE__ */ jsxs5("span", { className: "badge warn", children: [
          attention,
          " to review"
        ] }) : null
      ] })
    ] })
  ] });
}

// app/DashboardClient.js
import { Fragment as Fragment2, jsx as jsx6, jsxs as jsxs6 } from "react/jsx-runtime";
function plural(n, one, many) {
  return \`\${n} \${n === 1 ? one : many}\`;
}
function headline(stats) {
  if (stats.brands === 0) return ["Start with a brand folder", "Add a brand, then its products, and generate the infographic images for each listing."];
  if (stats.attention > 0) {
    return [
      \`\${plural(stats.attention, "image is", "images are")} waiting for you\`,
      \`\${stats.approved} of \${stats.slots} infographic images are approved across \${plural(stats.products, "product", "products")}.\`
    ];
  }
  if (stats.running > 0) {
    return ["Images are being generated", \`\${stats.approved} of \${stats.slots} infographic images are approved so far.\`];
  }
  if (stats.slots > 0 && stats.approved === stats.slots) {
    return ["Everything is approved", \`All \${plural(stats.slots, "image", "images")} across \${plural(stats.products, "product", "products")} are ready to download.\`];
  }
  return ["Ready for the next listing", \`\${plural(stats.products, "product", "products")} in \${plural(stats.brands, "brand folder", "brand folders")}. Open one to start generating images.\`];
}
function BrandFolder({ b }) {
  const pct = b.slotCount ? Math.round(b.approved / b.slotCount * 100) : 0;
  return /* @__PURE__ */ jsxs6(Link, { href: \`/brands/\${b.id}\`, className: "folder", children: [
    /* @__PURE__ */ jsx6("span", { className: "folder-tab" }),
    /* @__PURE__ */ jsxs6("div", { className: "folder-body", children: [
      /* @__PURE__ */ jsxs6("div", { className: "folder-head", children: [
        /* @__PURE__ */ jsx6(Avatar, { name: b.name, logo: b.logo }),
        /* @__PURE__ */ jsxs6("div", { className: "grow", children: [
          /* @__PURE__ */ jsx6("div", { className: "folder-name", children: b.name }),
          /* @__PURE__ */ jsx6("div", { className: "muted small", children: plural(b.productCount, "product", "products") })
        ] }),
        /* @__PURE__ */ jsx6(Icon, { name: "chevron", size: 16 })
      ] }),
      /* @__PURE__ */ jsx6("div", { className: "folder-thumbs", children: [0, 1, 2, 3].map((i) => b.thumbs[i] ? /* @__PURE__ */ jsx6("img", { src: \`/api/files/\${b.thumbs[i]}\`, alt: "", loading: "lazy" }, i) : /* @__PURE__ */ jsx6("span", { className: "ph" }, i)) }),
      /* @__PURE__ */ jsx6("div", { className: "meter", "aria-hidden": "true", children: /* @__PURE__ */ jsx6("i", { style: { width: \`\${pct}%\` } }) }),
      /* @__PURE__ */ jsx6("div", { className: "folder-foot", children: b.slotCount ? \`\${b.approved} of \${b.slotCount} images approved\` : "No images yet" })
    ] })
  ] });
}
function DashboardClient() {
  const { data, error, openNewBrand } = useDashboard();
  const [q, setQ] = useState5("");
  if (!data) {
    return /* @__PURE__ */ jsx6("div", { className: "page", children: error ? /* @__PURE__ */ jsx6("div", { className: "banner err", children: error }) : /* @__PURE__ */ jsx6("div", { className: "skeleton" }) });
  }
  const { stats, brands, products, recent, attention, setup } = data;
  const [title, sub] = headline(stats);
  const needle = q.trim().toLowerCase();
  const shownBrands = brands.filter((b) => !needle || b.name.toLowerCase().includes(needle) || products.some((p) => p.brand_id === b.id && p.name.toLowerCase().includes(needle)));
  const shownProducts = needle ? products.filter((p) => p.name.toLowerCase().includes(needle) || p.brand.toLowerCase().includes(needle)) : products.slice(0, 6);
  const pct = stats.slots ? Math.round(stats.approved / stats.slots * 100) : 0;
  const missing = [!setup.anthropic && "ANTHROPIC_API_KEY", !setup.gemini && "GEMINI_API_KEY"].filter(Boolean);
  return /* @__PURE__ */ jsxs6("div", { className: "page", children: [
    /* @__PURE__ */ jsxs6("section", { className: "hero", children: [
      /* @__PURE__ */ jsxs6("div", { children: [
        /* @__PURE__ */ jsx6("h1", { children: title }),
        /* @__PURE__ */ jsx6("p", { children: sub }),
        /* @__PURE__ */ jsxs6("div", { className: "hero-actions", children: [
          /* @__PURE__ */ jsxs6("button", { className: "btn btn-accent", onClick: openNewBrand, children: [
            /* @__PURE__ */ jsx6(Icon, { name: "plus", size: 16 }),
            " New brand folder"
          ] }),
          /* @__PURE__ */ jsx6(Link, { href: "/settings/templates", className: "btn btn-light", children: "Edit prompt templates" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs6("div", { className: "sheet", "aria-label": "Latest approved images", children: [
        /* @__PURE__ */ jsx6("div", { className: "sheet-grid", children: Array.from({ length: 8 }, (_, i) => {
          const r = recent[i];
          return r ? /* @__PURE__ */ jsx6(Link, { href: \`/products/\${r.product_id}\`, className: "sheet-tile", title: r.product, children: /* @__PURE__ */ jsx6("img", { src: \`/api/files/\${r.path}\`, alt: \`Approved image for \${r.product}\`, loading: "lazy" }) }, i) : /* @__PURE__ */ jsx6("span", { className: "sheet-tile empty" }, i);
        }) }),
        /* @__PURE__ */ jsx6("div", { className: "sheet-cap", children: recent.length ? "Latest approved images" : "Approved images will collect here" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs6("section", { className: "statband", "aria-label": "Summary", children: [
      /* @__PURE__ */ jsxs6("div", { className: "stat", children: [
        /* @__PURE__ */ jsx6("b", { children: stats.brands }),
        /* @__PURE__ */ jsx6("span", { children: "Brand folders" })
      ] }),
      /* @__PURE__ */ jsxs6("div", { className: "stat", children: [
        /* @__PURE__ */ jsx6("b", { children: stats.products }),
        /* @__PURE__ */ jsx6("span", { children: "Products" })
      ] }),
      /* @__PURE__ */ jsxs6("div", { className: "stat", children: [
        /* @__PURE__ */ jsxs6("b", { children: [
          stats.approved,
          /* @__PURE__ */ jsxs6("span", { style: { fontSize: 16, fontWeight: 500, color: "var(--muted)", fontFamily: "var(--f-body)" }, children: [
            " of ",
            stats.slots
          ] })
        ] }),
        /* @__PURE__ */ jsx6("span", { children: "Images approved" }),
        /* @__PURE__ */ jsx6("div", { className: "meter", "aria-hidden": "true", children: /* @__PURE__ */ jsx6("i", { style: { width: \`\${pct}%\` } }) })
      ] }),
      /* @__PURE__ */ jsxs6("div", { className: "stat", children: [
        /* @__PURE__ */ jsx6("b", { children: stats.attention }),
        /* @__PURE__ */ jsx6("span", { children: stats.running > 0 ? \`Need review, \${stats.running} running now\` : "Need your review" })
      ] })
    ] }),
    missing.length > 0 && /* @__PURE__ */ jsxs6("div", { className: "banner warn", style: { marginTop: 18, marginBottom: 0 }, children: [
      "Add ",
      missing.join(" and "),
      " to ",
      /* @__PURE__ */ jsx6("code", { children: ".env.local" }),
      " and restart the server before generating."
    ] }),
    !setup.password && /* @__PURE__ */ jsxs6("div", { className: "banner info", style: { marginTop: 12, marginBottom: 0 }, children: [
      "No ",
      /* @__PURE__ */ jsx6("code", { children: "APP_PASSWORD" }),
      " is set, so anyone who can open this page can use the tool."
    ] }),
    /* @__PURE__ */ jsxs6("div", { className: "dash-grid", children: [
      /* @__PURE__ */ jsxs6("div", { children: [
        /* @__PURE__ */ jsxs6("div", { className: "sec-head", children: [
          /* @__PURE__ */ jsx6("h2", { className: "grow", children: "Brand folders" }),
          /* @__PURE__ */ jsxs6("div", { className: "search", children: [
            /* @__PURE__ */ jsx6(Icon, { name: "search", size: 16 }),
            /* @__PURE__ */ jsx6("input", { type: "text", placeholder: "Search brands and products", value: q, onChange: (e) => setQ(e.target.value), "aria-label": "Search brands and products" })
          ] })
        ] }),
        brands.length === 0 ? /* @__PURE__ */ jsxs6("div", { className: "empty", children: [
          /* @__PURE__ */ jsx6("h3", { children: "No brand folders yet" }),
          /* @__PURE__ */ jsx6("p", { children: "A brand folder holds the brand's logo, colors and tone, plus every product you make images for." }),
          /* @__PURE__ */ jsxs6("button", { className: "btn btn-primary", onClick: openNewBrand, children: [
            /* @__PURE__ */ jsx6(Icon, { name: "plus", size: 16 }),
            " Create the first brand"
          ] })
        ] }) : shownBrands.length === 0 ? /* @__PURE__ */ jsxs6("div", { className: "empty", children: [
          /* @__PURE__ */ jsxs6("h3", { children: [
            'No match for "',
            q,
            '"'
          ] }),
          /* @__PURE__ */ jsx6("p", { children: "Try a different brand or product name." })
        ] }) : /* @__PURE__ */ jsxs6("div", { className: "folders", children: [
          shownBrands.map((b) => /* @__PURE__ */ jsx6(BrandFolder, { b }, b.id)),
          !needle && /* @__PURE__ */ jsxs6("button", { className: "folder new", onClick: openNewBrand, children: [
            /* @__PURE__ */ jsx6("span", { className: "folder-tab" }),
            /* @__PURE__ */ jsxs6("span", { className: "folder-body", children: [
              /* @__PURE__ */ jsx6(Icon, { name: "plus", size: 22 }),
              "New brand folder"
            ] })
          ] })
        ] }),
        shownProducts.length > 0 && /* @__PURE__ */ jsxs6(Fragment2, { children: [
          /* @__PURE__ */ jsx6("div", { className: "sec-head", style: { marginTop: 38 }, children: /* @__PURE__ */ jsx6("h2", { className: "grow", children: needle ? "Matching products" : "Recent products" }) }),
          /* @__PURE__ */ jsx6("div", { className: "pgrid", children: shownProducts.map((p) => /* @__PURE__ */ jsx6(ProductCard, { p, showBrand: true }, p.id)) })
        ] })
      ] }),
      /* @__PURE__ */ jsx6("aside", { children: /* @__PURE__ */ jsxs6("section", { className: "panel", children: [
        /* @__PURE__ */ jsxs6("div", { className: "panel-head", children: [
          /* @__PURE__ */ jsx6("h2", { className: "grow", children: "Needs your attention" }),
          attention.length > 0 && /* @__PURE__ */ jsx6("span", { className: "badge warn", children: stats.attention })
        ] }),
        attention.length === 0 ? /* @__PURE__ */ jsx6("p", { className: "muted small", children: "Nothing is waiting for you. Images that need a review or a prompt choice show up here." }) : /* @__PURE__ */ jsx6("div", { children: attention.map((a) => /* @__PURE__ */ jsxs6(Link, { href: \`/products/\${a.product_id}#slot-\${a.slot_id}\`, className: "arow", children: [
          /* @__PURE__ */ jsx6(StatusDot, { status: a.status }),
          /* @__PURE__ */ jsxs6("div", { className: "grow", children: [
            /* @__PURE__ */ jsx6("div", { className: "arow-title", children: a.product }),
            /* @__PURE__ */ jsxs6("div", { className: "muted small", children: [
              "Image ",
              a.position + 1,
              ", ",
              (TYPE_LABEL[a.type] || a.type).toLowerCase()
            ] })
          ] }),
          /* @__PURE__ */ jsx6("span", { className: \`badge \${STATUS[a.status][0]}\`, children: STATUS[a.status][1] })
        ] }, a.slot_id)) })
      ] }) })
    ] })
  ] });
}

// app/brands/[id]/BrandClient.js
import { useEffect as useEffect4, useState as useState6 } from "react";
import { Fragment as Fragment3, jsx as jsx7, jsxs as jsxs7 } from "react/jsx-runtime";
var SECTIONS = [
  {
    title: "Look",
    hint: "What the designer should use on every image.",
    fields: [
      ["colors", "Colors", "e.g. Primary navy #0B1F4B, accent orange #FF8A00, white backgrounds", 2],
      ["fonts", "Fonts", "e.g. Montserrat Bold for headlines, Open Sans for body text", 2]
    ]
  },
  {
    title: "Voice and rules",
    hint: "How the text sounds, and what to always or never do.",
    fields: [
      ["tone", "Tone of voice", "e.g. Confident, simple, friendly. Short punchy headlines.", 2],
      ["dos", "Always do", "e.g. Use flat icons. Keep lots of white space. Show the logo bottom-right.", 3],
      ["donts", "Never do", 'e.g. No stock-photo people. No red. Never use the word "cheap".', 3],
      ["notes", "Other notes", "Anything else the designer should know about this brand", 3]
    ]
  }
];
var FIELD_KEYS = SECTIONS.flatMap((s) => s.fields.map((f) => f[0]));
function BrandClient({ id }) {
  const router = useRouter();
  const { data, refresh } = useDashboard();
  const [brand, setBrand] = useState6(null);
  const [tab, setTab] = useState6("products");
  const [error, setError] = useState6("");
  const [saved, setSaved] = useState6(false);
  const [busy, setBusy] = useState6(false);
  const [productModal, setProductModal] = useState6(false);
  useEffect4(() => {
    (async () => {
      try {
        const { brand: brand2 } = await api(\`/api/brands/\${id}\`);
        setBrand(brand2);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, [id]);
  function set(field, value) {
    setSaved(false);
    setBrand((b) => ({ ...b, [field]: value }));
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const body = { name: brand.name || "" };
      for (const f of FIELD_KEYS) body[f] = brand[f] || "";
      await api(\`/api/brands/\${id}\`, { method: "PUT", body });
      setSaved(true);
      refresh();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }
  async function uploadLogo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const { logo } = await api(\`/api/brands/\${id}/logo\`, { method: "POST", body: form });
      setBrand((b) => ({ ...b, logo }));
      refresh();
    } catch (err) {
      setError(err.message);
    }
    e.target.value = "";
  }
  async function removeLogo() {
    await api(\`/api/brands/\${id}/logo\`, { method: "DELETE" });
    setBrand((b) => ({ ...b, logo: null }));
    refresh();
  }
  async function remove() {
    if (!window.confirm("Delete this brand with all its products, images and prompt overrides? This cannot be undone.")) return;
    try {
      await api(\`/api/brands/\${id}\`, { method: "DELETE" });
      await refresh();
      router.push("/");
    } catch (e) {
      setError(e.message);
    }
  }
  if (!brand) {
    return /* @__PURE__ */ jsx7("div", { className: "page", children: error ? /* @__PURE__ */ jsx7("div", { className: "banner err", children: error }) : /* @__PURE__ */ jsx7("div", { className: "skeleton" }) });
  }
  const products = (data?.products || []).filter((p) => p.brand_id === id);
  const approved = products.reduce((n, p) => n + p.approved, 0);
  const total = products.reduce((n, p) => n + p.total, 0);
  return /* @__PURE__ */ jsxs7("div", { className: "page", children: [
    /* @__PURE__ */ jsx7(Crumbs, { items: [{ href: "/", label: "Dashboard" }, { label: brand.name }] }),
    /* @__PURE__ */ jsxs7("header", { className: "page-head", children: [
      /* @__PURE__ */ jsx7(Avatar, { name: brand.name, logo: brand.logo, large: true }),
      /* @__PURE__ */ jsxs7("div", { className: "grow", children: [
        /* @__PURE__ */ jsx7("h1", { children: brand.name }),
        /* @__PURE__ */ jsxs7("p", { className: "muted", children: [
          products.length,
          " ",
          products.length === 1 ? "product" : "products",
          ", ",
          approved,
          " of ",
          total,
          " images approved"
        ] })
      ] }),
      /* @__PURE__ */ jsxs7("button", { className: "btn btn-primary", onClick: () => setProductModal(true), children: [
        /* @__PURE__ */ jsx7(Icon, { name: "plus", size: 16 }),
        " New product"
      ] })
    ] }),
    error && /* @__PURE__ */ jsx7("div", { className: "banner err", children: error }),
    /* @__PURE__ */ jsxs7("div", { className: "seg", role: "tablist", "aria-label": "Brand sections", children: [
      /* @__PURE__ */ jsx7("button", { role: "tab", "aria-selected": tab === "products", className: tab === "products" ? "on" : "", onClick: () => setTab("products"), children: "Products" }),
      /* @__PURE__ */ jsx7("button", { role: "tab", "aria-selected": tab === "profile", className: tab === "profile" ? "on" : "", onClick: () => setTab("profile"), children: "Brand profile" })
    ] }),
    tab === "products" && /* @__PURE__ */ jsxs7(Fragment3, { children: [
      products.length === 0 ? /* @__PURE__ */ jsxs7("div", { className: "empty", children: [
        /* @__PURE__ */ jsx7("h3", { children: "This folder has no products yet" }),
        /* @__PURE__ */ jsx7("p", { children: "Add a product, upload its real photos, and write a short brief for each infographic image." }),
        /* @__PURE__ */ jsxs7("button", { className: "btn btn-primary", onClick: () => setProductModal(true), children: [
          /* @__PURE__ */ jsx7(Icon, { name: "plus", size: 16 }),
          " Create the first product"
        ] })
      ] }) : /* @__PURE__ */ jsxs7("div", { className: "pgrid", children: [
        products.map((p) => /* @__PURE__ */ jsx7(ProductCard, { p }, p.id)),
        /* @__PURE__ */ jsxs7("button", { className: "pcard new", onClick: () => setProductModal(true), children: [
          /* @__PURE__ */ jsx7(Icon, { name: "plus", size: 22 }),
          "New product"
        ] })
      ] }),
      !brand.colors && !brand.tone && /* @__PURE__ */ jsxs7("div", { className: "banner info", style: { marginTop: 22 }, children: [
        "This brand profile is empty. Colors, fonts and tone make the generated prompts much more on-brand.",
        " ",
        /* @__PURE__ */ jsx7("button", { className: "btn btn-quiet btn-sm", onClick: () => setTab("profile"), children: "Fill in the profile" })
      ] })
    ] }),
    tab === "profile" && /* @__PURE__ */ jsxs7("div", { className: "stack", style: { maxWidth: 820 }, children: [
      /* @__PURE__ */ jsxs7("section", { className: "panel stack", children: [
        /* @__PURE__ */ jsxs7("div", { children: [
          /* @__PURE__ */ jsx7("h2", { children: "Identity" }),
          /* @__PURE__ */ jsx7("p", { className: "muted small", style: { marginTop: 3 }, children: "The logo is sent to the image model as a reference, so it is reproduced exactly." })
        ] }),
        /* @__PURE__ */ jsxs7("div", { children: [
          /* @__PURE__ */ jsx7("label", { className: "field", htmlFor: "brand-name", children: "Brand name" }),
          /* @__PURE__ */ jsx7("input", { id: "brand-name", type: "text", value: brand.name || "", onChange: (e) => set("name", e.target.value) })
        ] }),
        /* @__PURE__ */ jsxs7("div", { children: [
          /* @__PURE__ */ jsx7("label", { className: "field", children: "Logo (PNG, JPG or WebP)" }),
          /* @__PURE__ */ jsxs7("div", { className: "row", children: [
            brand.logo && /* @__PURE__ */ jsx7("div", { className: "photo", children: /* @__PURE__ */ jsx7("img", { src: \`/api/files/\${brand.logo}\`, alt: "Brand logo" }) }),
            /* @__PURE__ */ jsxs7("label", { className: "btn btn-quiet btn-sm filebtn", children: [
              brand.logo ? "Replace logo" : "Upload logo",
              /* @__PURE__ */ jsx7("input", { type: "file", accept: "image/png,image/jpeg,image/webp", onChange: uploadLogo })
            ] }),
            brand.logo && /* @__PURE__ */ jsx7("button", { className: "btn btn-danger btn-sm", onClick: removeLogo, children: "Remove logo" })
          ] })
        ] })
      ] }),
      SECTIONS.map((sec) => /* @__PURE__ */ jsxs7("section", { className: "panel stack", children: [
        /* @__PURE__ */ jsxs7("div", { children: [
          /* @__PURE__ */ jsx7("h2", { children: sec.title }),
          /* @__PURE__ */ jsx7("p", { className: "muted small", style: { marginTop: 3 }, children: sec.hint })
        ] }),
        sec.fields.map(([key, label, placeholder, rows]) => /* @__PURE__ */ jsxs7("div", { children: [
          /* @__PURE__ */ jsx7("label", { className: "field", htmlFor: \`f-\${key}\`, children: label }),
          /* @__PURE__ */ jsx7("textarea", { id: \`f-\${key}\`, rows, placeholder, value: brand[key] || "", onChange: (e) => set(key, e.target.value) })
        ] }, key))
      ] }, sec.title)),
      /* @__PURE__ */ jsxs7("div", { className: "row", children: [
        /* @__PURE__ */ jsx7("button", { className: "btn btn-primary", onClick: save, disabled: busy, children: busy ? "Saving..." : "Save brand" }),
        saved && /* @__PURE__ */ jsx7("span", { className: "badge ok", children: "Saved" }),
        /* @__PURE__ */ jsx7("div", { className: "grow" }),
        /* @__PURE__ */ jsx7(Link, { href: \`/settings/templates?scope=brand:\${id}\`, className: "btn btn-quiet btn-sm", children: "Customize prompt templates for this brand" }),
        /* @__PURE__ */ jsx7("button", { className: "btn btn-danger btn-sm", onClick: remove, children: "Delete brand" })
      ] })
    ] }),
    productModal && /* @__PURE__ */ jsx7(
      NameModal,
      {
        title: "New product",
        label: "Product name",
        placeholder: "e.g. Steel Water Bottle 750 ml",
        cta: "Create product",
        onClose: () => setProductModal(false),
        onSubmit: async (name) => {
          const { id: pid } = await api("/api/products", { method: "POST", body: { name, brand_id: id } });
          await refresh();
          setProductModal(false);
          router.push(\`/products/\${pid}\`);
        }
      }
    )
  ] });
}

// app/products/[id]/ProductClient.js
import { useCallback as useCallback2, useEffect as useEffect5, useState as useState7 } from "react";
import { Fragment as Fragment4, jsx as jsx8, jsxs as jsxs8 } from "react/jsx-runtime";
var BUSY = ["prompting", "generating"];
function ProductClient({ id }) {
  const router = useRouter();
  const { refresh: refreshDash } = useDashboard();
  const [data, setData] = useState7(null);
  const [error, setError] = useState7("");
  const load = useCallback2(async () => {
    try {
      setData(await api(\`/api/products/\${id}\`));
    } catch (e) {
      setError(e.message);
    }
  }, [id]);
  useEffect5(() => {
    load();
  }, [load]);
  const autoRunning = data?.product.auto_status === "running";
  const busy = !!data && (autoRunning || data.slots.some((s) => BUSY.includes(s.status)));
  useEffect5(() => {
    if (!busy) return void 0;
    const t = setInterval(load, 2e3);
    return () => clearInterval(t);
  }, [busy, load]);
  if (!data) {
    return /* @__PURE__ */ jsx8("div", { className: "page", children: error ? /* @__PURE__ */ jsx8("div", { className: "banner err", children: error }) : /* @__PURE__ */ jsx8("div", { className: "skeleton" }) });
  }
  const { product, brand, slots } = data;
  const approved = slots.filter((s) => s.status === "approved").length;
  const hasImages = slots.some((s) => s.images.length > 0);
  async function addSlot() {
    setError("");
    try {
      await api(\`/api/products/\${id}/add-slot\`, { method: "POST", body: { type: "other" } });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  async function removeProduct() {
    if (!window.confirm("Delete this product with all its images? This cannot be undone.")) return;
    try {
      await api(\`/api/products/\${id}\`, { method: "DELETE" });
      await refreshDash();
      router.push(\`/brands/\${brand.id}\`);
    } catch (e) {
      setError(e.message);
    }
  }
  return /* @__PURE__ */ jsxs8("div", { className: "page", children: [
    /* @__PURE__ */ jsx8(Crumbs, { items: [{ href: "/", label: "Dashboard" }, { href: \`/brands/\${brand.id}\`, label: brand.name }, { label: product.name }] }),
    /* @__PURE__ */ jsxs8("header", { className: "page-head", children: [
      /* @__PURE__ */ jsx8("div", { className: "thumb-lg", children: product.photos[0] ? /* @__PURE__ */ jsx8("img", { src: \`/api/files/\${product.photos[0]}\`, alt: "" }) : /* @__PURE__ */ jsx8(Icon, { name: "image", size: 26 }) }),
      /* @__PURE__ */ jsxs8("div", { className: "grow", children: [
        /* @__PURE__ */ jsx8("h1", { children: product.name }),
        /* @__PURE__ */ jsxs8("p", { className: "muted", children: [
          approved,
          " of ",
          slots.length,
          " images approved"
        ] })
      ] }),
      hasImages && /* @__PURE__ */ jsxs8("a", { className: "btn btn-quiet", href: \`/api/products/\${id}/export\`, children: [
        /* @__PURE__ */ jsx8(Icon, { name: "download", size: 16 }),
        " Download all (zip)"
      ] }),
      /* @__PURE__ */ jsx8("button", { className: "btn btn-danger", onClick: removeProduct, children: "Delete product" })
    ] }),
    error && /* @__PURE__ */ jsxs8("div", { className: "banner err row", children: [
      /* @__PURE__ */ jsx8("span", { className: "grow", children: error }),
      /* @__PURE__ */ jsx8("button", { className: "btn btn-ghost btn-sm", onClick: () => setError(""), children: "Dismiss" })
    ] }),
    /* @__PURE__ */ jsx8("nav", { className: "strip", "aria-label": "Images in this product", children: slots.map((s, i) => {
      const img = s.images.find((x) => x.approved) || s.images[0];
      return /* @__PURE__ */ jsxs8("a", { href: \`#slot-\${s.id}\`, className: "tile", children: [
        /* @__PURE__ */ jsx8("div", { className: "tile-img", children: img ? /* @__PURE__ */ jsx8("img", { src: \`/api/files/\${img.path}\`, alt: "" }) : i + 1 }),
        /* @__PURE__ */ jsxs8("div", { className: "tile-cap", children: [
          /* @__PURE__ */ jsx8(StatusDot, { status: s.status }),
          (STATUS[s.status] || ["", s.status])[1]
        ] })
      ] }, s.id);
    }) }),
    /* @__PURE__ */ jsxs8("div", { className: "workspace", children: [
      /* @__PURE__ */ jsxs8("div", { className: "ws-main", children: [
        slots.map((s, i) => /* @__PURE__ */ jsx8(SlotCard, { slot: s, index: i, locked: autoRunning, reload: load, onError: setError }, s.id)),
        /* @__PURE__ */ jsxs8("button", { className: "btn btn-quiet", onClick: addSlot, disabled: autoRunning, children: [
          /* @__PURE__ */ jsx8(Icon, { name: "plus", size: 16 }),
          " Add another image"
        ] })
      ] }),
      /* @__PURE__ */ jsxs8("aside", { className: "ws-side", children: [
        /* @__PURE__ */ jsx8(ProductPanel, { product, reload: load, onError: setError }),
        /* @__PURE__ */ jsx8(AutoPanel, { product, slots, reload: load, onError: setError })
      ] })
    ] })
  ] });
}
function ProductPanel({ product, reload, onError }) {
  const [name, setName] = useState7(product.name);
  const [details, setDetails] = useState7(product.details || "");
  const [retries, setRetries] = useState7(product.max_retries ?? 2);
  const [saved, setSaved] = useState7(false);
  const [busy, setBusy] = useState7(false);
  async function save() {
    setBusy(true);
    onError("");
    try {
      await api(\`/api/products/\${product.id}\`, { method: "PUT", body: { name, details, max_retries: Number(retries) } });
      setSaved(true);
      await reload();
    } catch (e) {
      onError(e.message);
    }
    setBusy(false);
  }
  async function upload(e) {
    const files = [...e.target.files || []];
    if (!files.length) return;
    onError("");
    try {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      await api(\`/api/products/\${product.id}/photos\`, { method: "POST", body: form });
      await reload();
    } catch (err) {
      onError(err.message);
    }
    e.target.value = "";
  }
  async function removePhoto(path) {
    try {
      await api(\`/api/products/\${product.id}/delete-photo\`, { method: "POST", body: { path } });
      await reload();
    } catch (e) {
      onError(e.message);
    }
  }
  const touch = (fn) => (e) => {
    fn(e.target.value);
    setSaved(false);
  };
  return /* @__PURE__ */ jsxs8("section", { className: "panel stack", children: [
    /* @__PURE__ */ jsx8("h2", { children: "Product" }),
    /* @__PURE__ */ jsxs8("div", { children: [
      /* @__PURE__ */ jsx8("label", { className: "field", htmlFor: "p-name", children: "Product name" }),
      /* @__PURE__ */ jsx8("input", { id: "p-name", type: "text", value: name, onChange: touch(setName) })
    ] }),
    /* @__PURE__ */ jsxs8("div", { children: [
      /* @__PURE__ */ jsx8("label", { className: "field", htmlFor: "p-details", children: "Product details (materials, sizes, what is included, key facts)" }),
      /* @__PURE__ */ jsx8(
        "textarea",
        {
          id: "p-details",
          rows: 3,
          value: details,
          placeholder: "e.g. 750 ml double-wall vacuum insulated steel bottle, keeps cold 24 h and hot 12 h, BPA free, 7.5 cm x 26 cm",
          onChange: touch(setDetails)
        }
      )
    ] }),
    /* @__PURE__ */ jsxs8("div", { children: [
      /* @__PURE__ */ jsx8("label", { className: "field", children: "Real product photos (1 to 3, required)" }),
      /* @__PURE__ */ jsx8("p", { className: "muted small", style: { marginBottom: 8 }, children: "The image model uses these to draw your actual product." }),
      /* @__PURE__ */ jsxs8("div", { className: "photos", children: [
        product.photos.map((p) => /* @__PURE__ */ jsxs8("div", { className: "photo", children: [
          /* @__PURE__ */ jsx8("img", { src: \`/api/files/\${p}\`, alt: "Product" }),
          /* @__PURE__ */ jsx8("button", { title: "Remove photo", "aria-label": "Remove photo", onClick: () => removePhoto(p), children: /* @__PURE__ */ jsx8(Icon, { name: "x", size: 13 }) })
        ] }, p)),
        product.photos.length < 3 && /* @__PURE__ */ jsxs8("label", { className: "photo filebtn", style: { display: "flex", alignItems: "center", justifyContent: "center", borderStyle: "dashed", color: "var(--muted)" }, title: "Add photos", children: [
          /* @__PURE__ */ jsx8(Icon, { name: "plus", size: 22 }),
          /* @__PURE__ */ jsx8("input", { type: "file", multiple: true, accept: "image/png,image/jpeg,image/webp", onChange: upload })
        ] })
      ] }),
      product.photos.length === 0 && /* @__PURE__ */ jsx8("div", { className: "small", style: { color: "var(--warn)", marginTop: 8 }, children: "Upload at least one photo before generating anything." })
    ] }),
    /* @__PURE__ */ jsxs8("div", { children: [
      /* @__PURE__ */ jsx8("label", { className: "field", htmlFor: "p-retries", children: "Auto-mode retries (0 to 5)" }),
      /* @__PURE__ */ jsx8("input", { id: "p-retries", type: "number", min: "0", max: "5", value: retries, onChange: touch(setRetries), style: { width: 110 } })
    ] }),
    /* @__PURE__ */ jsxs8("div", { className: "row", children: [
      /* @__PURE__ */ jsx8("button", { className: "btn btn-primary", onClick: save, disabled: busy || !name.trim(), children: busy ? "Saving..." : "Save product" }),
      saved && /* @__PURE__ */ jsx8("span", { className: "badge ok", children: "Saved" })
    ] })
  ] });
}
function AutoPanel({ product, slots, reload, onError }) {
  const [mode, setMode] = useState7(product.auto_mode === "finetune" ? "finetune" : "full");
  const [anchor, setAnchor] = useState7(product.anchor_slot_id || slots[0]?.id || "");
  const [spec, setSpec] = useState7(product.style_spec || "");
  const [dirty, setDirty] = useState7(false);
  const [busy, setBusy] = useState7(false);
  useEffect5(() => {
    if (!dirty) setSpec(product.style_spec || "");
  }, [product.style_spec, dirty]);
  const status = product.auto_status;
  const anchorSlot = slots.find((s) => s.id === product.anchor_slot_id);
  async function call(path, body) {
    setBusy(true);
    onError("");
    try {
      await api(\`/api/products/\${product.id}/\${path}\`, { method: "POST", body: body || {} });
      await reload();
    } catch (e) {
      onError(e.message);
    }
    setBusy(false);
  }
  async function saveSpec() {
    try {
      await api(\`/api/products/\${product.id}\`, { method: "PUT", body: { style_spec: spec } });
      setDirty(false);
      await reload();
    } catch (e) {
      onError(e.message);
    }
  }
  return /* @__PURE__ */ jsxs8("section", { className: "panel stack", children: [
    /* @__PURE__ */ jsx8("h2", { children: "Auto mode" }),
    status === "running" && /* @__PURE__ */ jsxs8("div", { className: "banner info row", style: { marginBottom: 0 }, children: [
      /* @__PURE__ */ jsxs8("span", { className: "grow", children: [
        /* @__PURE__ */ jsx8("span", { className: "spinner" }),
        product.auto_message || "Auto mode is running..."
      ] }),
      /* @__PURE__ */ jsx8("button", { className: "btn btn-danger btn-sm", onClick: () => call("auto-stop"), disabled: busy, children: "Stop" })
    ] }),
    status === "awaiting_anchor" && /* @__PURE__ */ jsxs8("div", { className: "banner warn", style: { marginBottom: 0 }, children: [
      /* @__PURE__ */ jsx8("div", { children: product.auto_message }),
      /* @__PURE__ */ jsx8("button", { className: "btn btn-quiet btn-sm", style: { marginTop: 10 }, onClick: () => call("auto-stop"), disabled: busy, children: "Cancel fine-tune" })
    ] }),
    (status === "done" || status === "stopped") && product.auto_message && /* @__PURE__ */ jsx8("div", { className: \`banner \${status === "done" ? "ok" : "warn"}\`, style: { marginBottom: 0 }, children: product.auto_message }),
    status !== "running" && status !== "awaiting_anchor" && /* @__PURE__ */ jsxs8(Fragment4, { children: [
      /* @__PURE__ */ jsx8("p", { className: "muted small", children: "Works on this product only. It writes the prompts, generates each image, checks quality and retries up to the limit above." }),
      /* @__PURE__ */ jsxs8("label", { className: \`choice \${mode === "full" ? "on" : ""}\`, children: [
        /* @__PURE__ */ jsx8("input", { type: "radio", name: "mode", checked: mode === "full", onChange: () => setMode("full") }),
        /* @__PURE__ */ jsxs8("span", { children: [
          /* @__PURE__ */ jsx8("b", { children: "Full auto" }),
          /* @__PURE__ */ jsx8("small", { children: "All images run on their own, no questions asked." })
        ] })
      ] }),
      /* @__PURE__ */ jsxs8("label", { className: \`choice \${mode === "finetune" ? "on" : ""}\`, children: [
        /* @__PURE__ */ jsx8("input", { type: "radio", name: "mode", checked: mode === "finetune", onChange: () => setMode("finetune") }),
        /* @__PURE__ */ jsxs8("span", { children: [
          /* @__PURE__ */ jsx8("b", { children: "Auto with fine-tune" }),
          /* @__PURE__ */ jsx8("small", { children: "You shape one anchor image by hand. The others copy its style." })
        ] })
      ] }),
      mode === "finetune" && /* @__PURE__ */ jsxs8("div", { children: [
        /* @__PURE__ */ jsx8("label", { className: "field", htmlFor: "anchor", children: "Style anchor image" }),
        /* @__PURE__ */ jsx8("select", { id: "anchor", value: anchor, onChange: (e) => setAnchor(Number(e.target.value)), children: slots.map((s, i) => /* @__PURE__ */ jsxs8("option", { value: s.id, children: [
          "Image ",
          i + 1,
          " (",
          TYPE_LABEL[s.type] || s.type,
          ")"
        ] }, s.id)) })
      ] }),
      /* @__PURE__ */ jsx8(
        "button",
        {
          className: "btn btn-accent",
          style: { width: "100%" },
          onClick: () => call("auto-start", { mode, anchorSlotId: mode === "finetune" ? Number(anchor) : void 0 }),
          disabled: busy || !slots.length,
          children: mode === "full" ? "Start full auto" : "Start fine-tune"
        }
      )
    ] }),
    (product.style_spec || spec) && /* @__PURE__ */ jsxs8("div", { children: [
      /* @__PURE__ */ jsxs8("label", { className: "field", htmlFor: "style-spec", children: [
        "Locked style",
        anchorSlot ? \` (from image \${slots.indexOf(anchorSlot) + 1})\` : ""
      ] }),
      /* @__PURE__ */ jsx8("p", { className: "muted small", style: { marginBottom: 8 }, children: "Added to every prompt in auto mode. You can edit it." }),
      /* @__PURE__ */ jsx8(
        "textarea",
        {
          id: "style-spec",
          rows: 5,
          value: spec,
          onChange: (e) => {
            setSpec(e.target.value);
            setDirty(true);
          }
        }
      ),
      /* @__PURE__ */ jsxs8("div", { className: "row", style: { marginTop: 10 }, children: [
        /* @__PURE__ */ jsx8("button", { className: "btn btn-quiet btn-sm", onClick: saveSpec, disabled: !dirty, children: "Save style" }),
        product.auto_mode === "finetune" && anchorSlot?.status === "approved" && status !== "running" && /* @__PURE__ */ jsx8(
          "button",
          {
            className: "btn btn-quiet btn-sm",
            onClick: () => {
              if (window.confirm("Regenerate all the other images in the style of the current anchor image? Existing images are kept in their history.")) call("restyle");
            },
            disabled: busy,
            children: "Re-run the other images in this style"
          }
        )
      ] })
    ] })
  ] });
}
function QC({ qc }) {
  if (!qc) return /* @__PURE__ */ jsx8("div", { className: "qc muted small", children: "No quality check result for this image." });
  if (qc.error) {
    return /* @__PURE__ */ jsxs8("div", { className: "qc", children: [
      /* @__PURE__ */ jsx8("span", { className: "badge warn", children: "Quality check unavailable" }),
      " ",
      /* @__PURE__ */ jsx8("span", { className: "small muted", children: qc.error })
    ] });
  }
  return /* @__PURE__ */ jsxs8("div", { className: "qc", children: [
    /* @__PURE__ */ jsx8("span", { className: \`badge \${qc.pass ? "ok" : "err"}\`, children: qc.pass ? "Quality check passed" : "Quality check found problems" }),
    " ",
    qc.summary && /* @__PURE__ */ jsx8("span", { className: "small muted", children: qc.summary }),
    qc.issues && qc.issues.length > 0 && /* @__PURE__ */ jsx8("ul", { children: qc.issues.map((i, k) => /* @__PURE__ */ jsxs8("li", { className: i.severity, children: [
      /* @__PURE__ */ jsxs8("b", { children: [
        String(i.category).replace("_", " "),
        ":"
      ] }),
      " ",
      i.message
    ] }, k)) })
  ] });
}
function SlotCard({ slot, index, locked, reload, onError }) {
  const [brief, setBrief] = useState7(slot.brief || "");
  const [note, setNote] = useState7("");
  const [edits, setEdits] = useState7({});
  const [viewId, setViewId] = useState7(null);
  const [acting, setActing] = useState7(false);
  const working = BUSY.includes(slot.status);
  const disabled = working || locked || acting;
  const [badgeCls, badgeLabel] = STATUS[slot.status] || ["", slot.status];
  async function act(action, body = {}) {
    setActing(true);
    onError("");
    try {
      await api(\`/api/slots/\${slot.id}/\${action}\`, { method: "POST", body });
      if (["choose", "generate", "redo"].includes(action)) setViewId(null);
      await reload();
    } catch (e) {
      onError(e.message);
    }
    setActing(false);
  }
  async function saveSlot(patch) {
    try {
      await api(\`/api/slots/\${slot.id}\`, { method: "PUT", body: patch });
    } catch (e) {
      onError(e.message);
    }
  }
  async function remove() {
    if (!window.confirm(\`Delete image \${index + 1} and everything generated for it?\`)) return;
    try {
      await api(\`/api/slots/\${slot.id}\`, { method: "DELETE" });
      await reload();
    } catch (e) {
      onError(e.message);
    }
  }
  const variations = slot.prompts.filter((p) => p.source === "variation");
  const batch = variations.length ? variations[0].batch : null;
  const batchPrompts = variations.filter((p) => p.batch === batch).sort((a, b) => a.id - b.id);
  const img = slot.images.find((i) => i.id === viewId) || slot.images[0];
  const imgPrompt = img ? slot.prompts.find((p) => p.id === img.prompt_id) : null;
  const isCurrentPrompt = imgPrompt && imgPrompt.id === slot.selected_prompt_id;
  return /* @__PURE__ */ jsxs8("section", { className: "slot", id: \`slot-\${slot.id}\`, children: [
    /* @__PURE__ */ jsxs8("div", { className: "slot-top", children: [
      /* @__PURE__ */ jsx8("div", { className: "slot-num", children: index + 1 }),
      /* @__PURE__ */ jsx8("select", { className: "select-sm", defaultValue: slot.type, disabled, onChange: (e) => saveSlot({ type: e.target.value }), "aria-label": \`Type of image \${index + 1}\`, children: TYPE_OPTIONS.map(([v, l]) => /* @__PURE__ */ jsx8("option", { value: v, children: l }, v)) }),
      /* @__PURE__ */ jsx8("span", { className: \`badge \${badgeCls}\`, children: badgeLabel }),
      /* @__PURE__ */ jsx8("div", { className: "grow" }),
      /* @__PURE__ */ jsx8("button", { className: "btn btn-ghost btn-sm", onClick: remove, disabled, children: "Delete" })
    ] }),
    /* @__PURE__ */ jsxs8("div", { className: "slot-body", children: [
      /* @__PURE__ */ jsxs8("div", { className: "slot-visual", children: [
        /* @__PURE__ */ jsx8("div", { className: \`frame \${working ? "loading" : ""}\`, children: img ? /* @__PURE__ */ jsx8("img", { className: "generated", src: \`/api/files/\${img.path}\`, alt: \`Generated image \${index + 1}\` }) : !working && /* @__PURE__ */ jsxs8("div", { className: "frame-empty", children: [
          /* @__PURE__ */ jsx8(Icon, { name: "image", size: 30 }),
          /* @__PURE__ */ jsx8("span", { children: "Your image appears here" })
        ] }) }),
        slot.images.length > 1 && /* @__PURE__ */ jsx8("div", { className: "thumbs", children: slot.images.map((i) => /* @__PURE__ */ jsx8(
          "img",
          {
            src: \`/api/files/\${i.path}\`,
            alt: "Earlier version",
            className: \`\${i.id === img.id ? "sel" : ""} \${i.approved ? "appr" : ""}\`,
            onClick: () => setViewId(i.id)
          },
          i.id
        )) })
      ] }),
      /* @__PURE__ */ jsxs8("div", { className: "side stack", children: [
        /* @__PURE__ */ jsxs8("div", { children: [
          /* @__PURE__ */ jsx8("label", { className: "field", htmlFor: \`brief-\${slot.id}\`, children: "What should this image show?" }),
          /* @__PURE__ */ jsx8(
            "textarea",
            {
              id: \`brief-\${slot.id}\`,
              rows: 3,
              value: brief,
              placeholder: "e.g. Show the bottle with callouts for: 24h cold / 12h hot, leak-proof lid, fits car cup holders, BPA free",
              onChange: (e) => setBrief(e.target.value),
              onBlur: () => brief !== (slot.brief || "") && saveSlot({ brief }),
              disabled: working
            }
          )
        ] }),
        working && /* @__PURE__ */ jsxs8("div", { className: "banner info", style: { marginBottom: 0 }, children: [
          /* @__PURE__ */ jsx8("span", { className: "spinner" }),
          slot.message || "Working..."
        ] }),
        slot.status === "error" && /* @__PURE__ */ jsx8("div", { className: "banner err", style: { marginBottom: 0 }, children: slot.message || "Something went wrong." }),
        slot.status === "review" && slot.message && /* @__PURE__ */ jsx8("div", { className: "banner warn", style: { marginBottom: 0 }, children: slot.message }),
        /* @__PURE__ */ jsx8("div", { className: "row", children: /* @__PURE__ */ jsx8(
          "button",
          {
            className: \`btn \${slot.images.length ? "btn-quiet" : "btn-primary"}\`,
            onClick: async () => {
              if (brief !== (slot.brief || "")) await saveSlot({ brief });
              act("variations");
            },
            disabled: disabled || !brief.trim(),
            children: variations.length ? "Write new prompt variations" : "Write 3 prompt variations"
          }
        ) }),
        img && /* @__PURE__ */ jsxs8(Fragment4, { children: [
          /* @__PURE__ */ jsxs8("div", { className: "row", children: [
            img.approved ? /* @__PURE__ */ jsxs8("span", { className: "badge ok", children: [
              /* @__PURE__ */ jsx8(Icon, { name: "check", size: 14 }),
              " Approved"
            ] }) : /* @__PURE__ */ jsx8("button", { className: "btn btn-primary", onClick: () => act("approve", { imageId: img.id }), disabled, children: "Approve this image" }),
            /* @__PURE__ */ jsxs8("a", { className: "btn btn-quiet", href: \`/api/files/\${img.path}\`, download: true, children: [
              /* @__PURE__ */ jsx8(Icon, { name: "download", size: 16 }),
              " Download"
            ] })
          ] }),
          /* @__PURE__ */ jsx8(QC, { qc: img.qc }),
          /* @__PURE__ */ jsxs8("div", { className: "redo", children: [
            /* @__PURE__ */ jsx8("h3", { children: "Not happy? Redo with a new prompt" }),
            /* @__PURE__ */ jsx8("p", { className: "muted small", style: { margin: "4px 0 10px" }, children: "Claude looks at this image, writes one new prompt using your note, then generates again. Leave the note empty for a fresh take." }),
            /* @__PURE__ */ jsx8("input", { type: "text", value: note, placeholder: "e.g. product too small, text too crowded", onChange: (e) => setNote(e.target.value), disabled }),
            /* @__PURE__ */ jsxs8("div", { className: "row", style: { marginTop: 10 }, children: [
              /* @__PURE__ */ jsx8(
                "button",
                {
                  className: "btn btn-primary",
                  onClick: async () => {
                    await act("redo", { note });
                    setNote("");
                  },
                  disabled,
                  children: "Redo"
                }
              ),
              /* @__PURE__ */ jsx8("button", { className: "btn btn-quiet btn-sm", onClick: () => act("generate"), disabled: disabled || !slot.selected_prompt_id, children: "Regenerate with the same prompt" })
            ] })
          ] }),
          imgPrompt && /* @__PURE__ */ jsxs8("details", { className: "prompt-details", children: [
            /* @__PURE__ */ jsxs8("summary", { children: [
              "Prompt used for this image",
              imgPrompt.source === "redo" ? " (written by Claude after a redo)" : ""
            ] }),
            isCurrentPrompt ? /* @__PURE__ */ jsxs8("div", { style: { marginTop: 10 }, children: [
              /* @__PURE__ */ jsx8(
                "textarea",
                {
                  className: "mono",
                  rows: 9,
                  value: edits[imgPrompt.id] ?? imgPrompt.text,
                  onChange: (e) => setEdits({ ...edits, [imgPrompt.id]: e.target.value }),
                  disabled
                }
              ),
              /* @__PURE__ */ jsx8(
                "button",
                {
                  className: "btn btn-quiet btn-sm",
                  style: { marginTop: 8 },
                  onClick: () => act("choose", { promptId: imgPrompt.id, text: edits[imgPrompt.id] ?? imgPrompt.text }),
                  disabled,
                  children: "Generate with this edited prompt"
                }
              )
            ] }) : /* @__PURE__ */ jsx8("pre", { className: "mono locked", style: { marginTop: 10 }, children: imgPrompt.text }),
            imgPrompt.template_version && /* @__PURE__ */ jsxs8("div", { className: "small muted", style: { marginTop: 6 }, children: [
              "Template version: ",
              imgPrompt.template_version
            ] })
          ] })
        ] })
      ] }),
      slot.status === "choose" && batchPrompts.length > 0 && /* @__PURE__ */ jsxs8("div", { className: "slot-variations", children: [
        /* @__PURE__ */ jsx8("h3", { children: "Choose a prompt" }),
        /* @__PURE__ */ jsx8("p", { className: "muted small", style: { marginTop: 3 }, children: "You can edit any prompt before generating." }),
        /* @__PURE__ */ jsx8("div", { className: "variations", children: batchPrompts.map((p) => /* @__PURE__ */ jsxs8("div", { className: \`variation \${p.recommended ? "rec" : ""}\`, children: [
          /* @__PURE__ */ jsxs8("div", { className: "row", style: { marginBottom: 8 }, children: [
            /* @__PURE__ */ jsx8("b", { children: p.label }),
            p.recommended ? /* @__PURE__ */ jsx8("span", { className: "badge warn", children: "Claude recommends" }) : null
          ] }),
          /* @__PURE__ */ jsx8("textarea", { className: "mono", value: edits[p.id] ?? p.text, onChange: (e) => setEdits({ ...edits, [p.id]: e.target.value }), disabled }),
          /* @__PURE__ */ jsx8("button", { className: "btn btn-primary", style: { marginTop: 10, width: "100%" }, onClick: () => act("choose", { promptId: p.id, text: edits[p.id] ?? p.text }), disabled, children: "Use this and generate image" })
        ] }, p.id)) })
      ] })
    ] })
  ] });
}

// app/settings/templates/TemplatesClient.js
import { useCallback as useCallback3, useEffect as useEffect6, useRef, useState as useState8 } from "react";
import { jsx as jsx9, jsxs as jsxs9 } from "react/jsx-runtime";
var KEYS = ["variations", "redo", "style_spec", "qc"];
var SHORT = { variations: "Variations", redo: "Redo", style_spec: "Style spec", qc: "Quality check" };
function TemplatesClient({ initialScope }) {
  const [scope, setScope] = useState8(initialScope || "global");
  const [data, setData] = useState8(null);
  const [drafts, setDrafts] = useState8({});
  const [active, setActive] = useState8("variations");
  const [error, setError] = useState8("");
  const [notice, setNotice] = useState8("");
  const [busy, setBusy] = useState8(false);
  const [testSlot, setTestSlot] = useState8("");
  const [testing, setTesting] = useState8(false);
  const [testResult, setTestResult] = useState8(null);
  const ta = useRef(null);
  const load = useCallback3(async (sc) => {
    setError("");
    try {
      const d = await api(\`/api/templates?scope=\${encodeURIComponent(sc)}\`);
      setData(d);
      const next = {};
      for (const k of KEYS) next[k] = d.templates[k].content;
      setDrafts(next);
      setTestResult(null);
      setTestSlot((cur) => cur || (d.testTargets[0] ? String(d.testTargets[0].id) : ""));
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect6(() => {
    load(scope);
  }, [scope, load]);
  if (!data) {
    return /* @__PURE__ */ jsx9("div", { className: "page", children: error ? /* @__PURE__ */ jsx9("div", { className: "banner err", children: error }) : /* @__PURE__ */ jsx9("div", { className: "skeleton" }) });
  }
  const t = data.templates[active];
  const draft = drafts[active] ?? "";
  const dirty = draft !== t.content;
  const known = new Set(data.placeholders.map((p) => p.name));
  const unknown = [...new Set([...draft.matchAll(/\\{\\{\\s*([A-Za-z_]+)\\s*\\}\\}/g)].map((m) => m[1]).filter((n) => !known.has(n)))];
  const isBrand = scope !== "global";
  function sourceText() {
    if (t.source === "brand") return \`this brand's own override (\${t.version})\`;
    if (t.source === "global") return \`your global edit (\${t.version})\`;
    return "the built-in default";
  }
  function insertPlaceholder(name) {
    const el = ta.current;
    const tag = \`{{\${name}}}\`;
    if (!el) {
      setDrafts({ ...drafts, [active]: draft + tag });
      return;
    }
    const a = el.selectionStart;
    const b = el.selectionEnd;
    setDrafts({ ...drafts, [active]: draft.slice(0, a) + tag + draft.slice(b) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + tag.length, a + tag.length);
    });
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await api("/api/templates", { method: "PUT", body: { scope, key: active, content: draft } });
      setNotice(\`Saved as version \${r.version}.\`);
      await load(scope);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }
  async function reset() {
    const msg = isBrand ? "Remove this brand's override so it uses the global template again?" : "Reset this template to the built-in default? The current text stays in the version history.";
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/templates", { method: "POST", body: { action: "reset", scope, key: active } });
      setNotice(isBrand ? "Override removed." : "Reset to the built-in default.");
      await load(scope);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }
  async function runTest() {
    setTesting(true);
    setError("");
    setTestResult(null);
    try {
      setTestResult(await api("/api/templates", { method: "POST", body: { action: "test", slotId: Number(testSlot), content: draft } }));
    } catch (e) {
      setError(e.message);
    }
    setTesting(false);
  }
  return /* @__PURE__ */ jsxs9("div", { className: "page", children: [
    /* @__PURE__ */ jsx9(Crumbs, { items: [{ href: "/", label: "Dashboard" }, { label: "Prompt templates" }] }),
    /* @__PURE__ */ jsxs9("header", { className: "page-head", children: [
      /* @__PURE__ */ jsxs9("div", { className: "grow", children: [
        /* @__PURE__ */ jsx9("h1", { children: "Prompt templates" }),
        /* @__PURE__ */ jsx9("p", { className: "muted", style: { maxWidth: "62ch" }, children: "These are the instructions Claude follows when it writes image prompts. Every prompt records which template version produced it." })
      ] }),
      /* @__PURE__ */ jsxs9("div", { style: { width: 280 }, children: [
        /* @__PURE__ */ jsx9("label", { className: "field", htmlFor: "scope", children: "Applies to" }),
        /* @__PURE__ */ jsxs9("select", { id: "scope", value: scope, onChange: (e) => setScope(e.target.value), children: [
          /* @__PURE__ */ jsx9("option", { value: "global", children: "Global (all brands)" }),
          data.brands.map((b) => /* @__PURE__ */ jsxs9("option", { value: \`brand:\${b.id}\`, children: [
            "Brand override: ",
            b.name
          ] }, b.id))
        ] })
      ] })
    ] }),
    error && /* @__PURE__ */ jsx9("div", { className: "banner err", children: error }),
    notice && /* @__PURE__ */ jsx9("div", { className: "banner ok", children: notice }),
    /* @__PURE__ */ jsx9("p", { className: "muted small", style: { marginBottom: 18 }, children: isBrand ? "A brand override replaces the global template for this brand only. Brands without an override use the global one." : "Used by every brand that has no override of its own." }),
    /* @__PURE__ */ jsxs9("div", { className: "tpl", children: [
      /* @__PURE__ */ jsx9("div", { className: "rail", role: "tablist", "aria-label": "Templates", children: KEYS.map((k) => /* @__PURE__ */ jsxs9("button", { role: "tab", "aria-selected": k === active, className: k === active ? "on" : "", onClick: () => setActive(k), children: [
        SHORT[k],
        drafts[k] !== data.templates[k].content ? " *" : ""
      ] }, k)) }),
      /* @__PURE__ */ jsxs9("div", { className: "stack", children: [
        /* @__PURE__ */ jsxs9("section", { className: "panel stack", children: [
          /* @__PURE__ */ jsxs9("div", { children: [
            /* @__PURE__ */ jsx9("h2", { children: t.title }),
            /* @__PURE__ */ jsx9("p", { className: "muted small", style: { marginTop: 3 }, children: t.description }),
            /* @__PURE__ */ jsxs9("p", { className: "small", style: { marginTop: 6 }, children: [
              "Currently using: ",
              /* @__PURE__ */ jsx9("b", { children: sourceText() })
            ] })
          ] }),
          /* @__PURE__ */ jsxs9("div", { children: [
            /* @__PURE__ */ jsx9("p", { className: "muted small", style: { marginBottom: 6 }, children: "Click a placeholder to insert it at your cursor. The app fills it in automatically." }),
            /* @__PURE__ */ jsx9("div", { children: data.placeholders.map((p) => /* @__PURE__ */ jsx9("span", { className: "chip", title: p.description, onClick: () => insertPlaceholder(p.name), children: \`{{\${p.name}}}\` }, p.name)) })
          ] }),
          /* @__PURE__ */ jsx9("textarea", { ref: ta, className: "mono", rows: 24, value: draft, onChange: (e) => setDrafts({ ...drafts, [active]: e.target.value }), "aria-label": "Template text" }),
          unknown.length > 0 && /* @__PURE__ */ jsxs9("div", { className: "banner warn", style: { marginBottom: 0 }, children: [
            "Unknown placeholder",
            unknown.length > 1 ? "s" : "",
            ": ",
            unknown.map((u) => \`{{\${u}}}\`).join(", "),
            ". ",
            unknown.length > 1 ? "They" : "It",
            " will be sent to Claude as plain text."
          ] }),
          /* @__PURE__ */ jsxs9("div", { children: [
            /* @__PURE__ */ jsx9("label", { className: "field", children: "Fixed output format (added automatically, not editable, so the app can always read Claude's answer)" }),
            /* @__PURE__ */ jsx9("div", { className: "locked mono", children: t.locked })
          ] }),
          /* @__PURE__ */ jsxs9("div", { className: "row", children: [
            /* @__PURE__ */ jsx9("button", { className: "btn btn-primary", onClick: save, disabled: busy || !dirty || !isBrand && !draft.trim(), children: busy ? "Working..." : "Save new version" }),
            dirty && /* @__PURE__ */ jsx9("button", { className: "btn btn-ghost", onClick: () => setDrafts({ ...drafts, [active]: t.content }), children: "Discard changes" }),
            /* @__PURE__ */ jsx9("div", { className: "grow" }),
            /* @__PURE__ */ jsx9("button", { className: "btn btn-danger", onClick: reset, disabled: busy || (isBrand ? t.source !== "brand" : false), children: isBrand ? "Remove override" : "Reset to default" })
          ] })
        ] }),
        active === "variations" && /* @__PURE__ */ jsxs9("section", { className: "panel stack", children: [
          /* @__PURE__ */ jsxs9("div", { children: [
            /* @__PURE__ */ jsx9("h2", { children: "Test this template" }),
            /* @__PURE__ */ jsx9("p", { className: "muted small", style: { marginTop: 3 }, children: "Runs the text above, including unsaved edits, on a real image slot and shows the 3 prompt variations. Nothing is saved and no image is generated, so it costs very little." })
          ] }),
          data.testTargets.length === 0 ? /* @__PURE__ */ jsx9("p", { className: "muted", children: "Add a product with at least one photo first." }) : /* @__PURE__ */ jsxs9("div", { className: "row", children: [
            /* @__PURE__ */ jsx9("select", { value: testSlot, onChange: (e) => setTestSlot(e.target.value), style: { maxWidth: 380 }, "aria-label": "Image to test on", children: data.testTargets.map((x) => /* @__PURE__ */ jsxs9("option", { value: x.id, children: [
              x.brand,
              " / ",
              x.product,
              " / image ",
              x.position + 1,
              " (",
              x.type,
              ")"
            ] }, x.id)) }),
            /* @__PURE__ */ jsx9("button", { className: "btn btn-quiet", onClick: runTest, disabled: testing || !testSlot, children: testing ? "Running..." : "Run test" })
          ] }),
          testResult && /* @__PURE__ */ jsx9("div", { className: "variations", children: testResult.variations.map((v, i) => /* @__PURE__ */ jsxs9("div", { className: \`variation \${i === testResult.recommended ? "rec" : ""}\`, children: [
            /* @__PURE__ */ jsxs9("div", { className: "row", style: { marginBottom: 8 }, children: [
              /* @__PURE__ */ jsx9("b", { children: v.label || \`Variation \${i + 1}\` }),
              i === testResult.recommended && /* @__PURE__ */ jsx9("span", { className: "badge warn", children: "Claude recommends" })
            ] }),
            /* @__PURE__ */ jsx9("pre", { className: "mono", style: { whiteSpace: "pre-wrap", margin: 0 }, children: v.prompt })
          ] }, i)) })
        ] }),
        /* @__PURE__ */ jsxs9("section", { className: "panel", children: [
          /* @__PURE__ */ jsx9("h2", { children: "Version history" }),
          t.history.length === 0 ? /* @__PURE__ */ jsx9("p", { className: "muted small", children: "No saved versions yet. The built-in default is in use." }) : /* @__PURE__ */ jsx9("div", { children: t.history.map((h) => /* @__PURE__ */ jsxs9("div", { className: "arow", children: [
            /* @__PURE__ */ jsxs9("b", { children: [
              "v",
              h.version
            ] }),
            /* @__PURE__ */ jsxs9("span", { className: "muted small grow", children: [
              new Date(h.created_at).toLocaleString(),
              h.content.trim() ? "" : " (override removed)"
            ] }),
            h.content.trim() && /* @__PURE__ */ jsx9("button", { className: "btn btn-ghost btn-sm", onClick: () => setDrafts({ ...drafts, [active]: h.content }), children: "Load into editor" })
          ] }, h.version)) })
        ] })
      ] })
    ] })
  ] });
}

// app/main.js
import { jsx as jsx10 } from "react/jsx-runtime";
function Page({ url }) {
  const path = url.split("?")[0];
  let m;
  if (path === "/login") return /* @__PURE__ */ jsx10(Login, {});
  if (m = /^\\/brands\\/(\\d+)$/.exec(path)) return /* @__PURE__ */ jsx10(BrandClient, { id: Number(m[1]) }, m[1]);
  if (m = /^\\/products\\/(\\d+)$/.exec(path)) return /* @__PURE__ */ jsx10(ProductClient, { id: Number(m[1]) }, m[1]);
  if (path === "/settings/templates") {
    return /* @__PURE__ */ jsx10(TemplatesClient, { initialScope: new URLSearchParams(location.search).get("scope") || "global" }, url);
  }
  return /* @__PURE__ */ jsx10(DashboardClient, {});
}
function App() {
  return /* @__PURE__ */ jsx10(Shell, { children: /* @__PURE__ */ jsx10(Page, { url: useUrl() }) });
}
createRoot(document.getElementById("root")).render(/* @__PURE__ */ jsx10(App, {}));
`;

// ===========================================================================
// Entry
// ===========================================================================
const PUBLIC = new Set(['/login', '/api/login', '/app.js', '/app.css', '/favicon.ico']);

export default {
  async fetch(req, env) {
    ENV = env;
    const url = new URL(req.url);
    const path = url.pathname;

    if (ENV.APP_PASSWORD && !PUBLIC.has(path) && cookie(req, 'session') !== (await sessionToken(ENV.APP_PASSWORD))) {
      return path.startsWith('/api/') ? json({ error: 'Unauthorized' }, 401) : Response.redirect(new URL('/login', url), 302);
    }

    if (path === '/app.js') return new Response(APP_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
    if (path === '/app.css') return new Response(CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } });
    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (!path.startsWith('/api/')) return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    for (const [method, re, fn] of routes) {
      const m = req.method === method && re.exec(path);
      if (!m) continue;
      try {
        await ensureSchema();
        return await fn(req, m.groups || {});
      } catch (e) {
        return json({ error: errMsg(e) }, e && e.status ? e.status : 500);
      }
    }
    return json({ error: 'Not found' }, 404);
  },
};
