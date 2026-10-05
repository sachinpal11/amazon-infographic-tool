import { all, get } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';
import {
  TEMPLATE_KEYS,
  TEMPLATE_META,
  PLACEHOLDERS,
  LOCKED,
  DEFAULTS,
  getTemplate,
  saveTemplate,
  templateHistory,
  unknownPlaceholders,
} from '@/lib/templates.js';
import { testVariationTemplate } from '@/lib/pipeline.js';

export const dynamic = 'force-dynamic';

function parseScope(scope) {
  if (scope === 'global') return { scope, brandId: null };
  const m = /^brand:(\d+)$/.exec(scope || '');
  if (!m || !get('SELECT id FROM brands WHERE id=?', Number(m[1]))) throw new HttpError(400, 'Unknown scope');
  return { scope, brandId: Number(m[1]) };
}

function describeScope(scope, brandId) {
  const templates = {};
  for (const key of TEMPLATE_KEYS) {
    const eff = getTemplate(key, brandId);
    templates[key] = {
      ...TEMPLATE_META[key],
      content: eff.content,
      source: eff.source, // default | global | brand
      version: eff.version,
      overridden: brandId ? eff.source === 'brand' : eff.source === 'global',
      locked: LOCKED[key],
      history: templateHistory(scope, key),
      warnings: unknownPlaceholders(eff.content),
    };
  }
  return templates;
}

export const GET = handle(async (req) => {
  const scope = new URL(req.url).searchParams.get('scope') || 'global';
  const { brandId } = parseScope(scope);
  return json({
    scope,
    templates: describeScope(scope, brandId),
    placeholders: PLACEHOLDERS,
    brands: all('SELECT id, name FROM brands ORDER BY name'),
    testTargets: all(
      `SELECT s.id, s.position, s.type, p.name AS product, b.name AS brand
       FROM slots s JOIN products p ON p.id = s.product_id JOIN brands b ON b.id = p.brand_id
       WHERE p.photos <> '[]' ORDER BY b.name, p.name, s.position`
    ),
  });
});

export const PUT = handle(async (req) => {
  const { scope, key, content } = await req.json();
  parseScope(scope);
  if (!TEMPLATE_KEYS.includes(key)) throw new HttpError(400, 'Unknown template');
  const text = String(content ?? '');
  if (scope === 'global' && !text.trim()) throw new HttpError(400, 'The template cannot be empty. Use "Reset to default" instead.');
  const version = saveTemplate(scope, key, text);
  return json({ version, warnings: unknownPlaceholders(text) });
});

export const POST = handle(async (req) => {
  const body = await req.json();
  if (body.action === 'reset') {
    parseScope(body.scope);
    if (!TEMPLATE_KEYS.includes(body.key)) throw new HttpError(400, 'Unknown template');
    // global: save the built-in default as a new version (history is kept)
    // brand: save an empty version, which means "inherit the global template"
    const version = saveTemplate(body.scope, body.key, body.scope === 'global' ? DEFAULTS[body.key] : '');
    return json({ version });
  }
  if (body.action === 'test') {
    if (!String(body.content || '').trim()) throw new HttpError(400, 'The template is empty.');
    const result = await testVariationTemplate(Number(body.slotId), String(body.content));
    return json(result);
  }
  throw new HttpError(400, 'Unknown action');
});
