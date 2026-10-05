// API smoke test: calls the route handlers directly with a fake AI and a temporary database.
// Run: npx tsx --tsconfig jsconfig.json scripts/test-api.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'infographic-api-'));

const { ai } = await import('../lib/ai.js');
ai.prepImage = async () => ({ mime: 'image/png', data: 'AAAA' });
let n = 0;
ai.generateImageGemini = async () => ({ buf: Buffer.from('PNGDATA' + ++n), mime: 'image/png' });
ai.askClaude = async (text) => {
  if (text.includes('"variations":[{"label"')) {
    const c = Number(/exactly (\d+) item/.exec(text)[1]);
    return JSON.stringify({ variations: Array.from({ length: c }, (_, i) => ({ label: `V${i + 1}`, prompt: `P${i + 1}` })), recommended: 1 % c });
  }
  if (text.includes('{"prompt":"the complete new')) return JSON.stringify({ prompt: 'Better prompt' });
  if (text.includes('"pass":true')) return JSON.stringify({ pass: true, summary: 'fine', issues: [{ severity: 'warning', category: 'layout', message: 'a bit tight' }] });
  if (text.includes('style specification')) return 'Navy style';
  throw new Error('unexpected');
};

const R = {
  dashboard: await import('../app/api/dashboard/route.js'),
  brands: await import('../app/api/brands/route.js'),
  brand: await import('../app/api/brands/[id]/route.js'),
  logo: await import('../app/api/brands/[id]/logo/route.js'),
  products: await import('../app/api/products/route.js'),
  product: await import('../app/api/products/[id]/route.js'),
  productAct: await import('../app/api/products/[id]/[action]/route.js'),
  slot: await import('../app/api/slots/[id]/route.js'),
  slotAct: await import('../app/api/slots/[id]/[action]/route.js'),
  files: await import('../app/api/files/[...path]/route.js'),
  templates: await import('../app/api/templates/route.js'),
};

async function call(handler, { method = 'GET', url = 'http://localhost/api/x', body, form, params = {} } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (form) init.body = form;
  const res = await handler(new Request(url, init), { params: Promise.resolve(params) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const png = (name) => new File([Buffer.from('89504e470d0a1a0a', 'hex')], name, { type: 'image/png' });
const tree = async (pid) => (await call(R.product.GET, { params: { id: String(pid) } })).body;
const waitFor = async (fn, what, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout: ' + what);
};

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', `${name} -> ${e.stack || e.message}`]);
  }
};
let brandId, pid, slots;

await test('brand: create, update, read, logo upload, bad logo type', async () => {
  let r = await call(R.brands.POST, { method: 'POST', body: { name: 'Acme' } });
  assert.equal(r.status, 200);
  brandId = r.body.id;
  assert.equal((await call(R.brands.POST, { method: 'POST', body: { name: ' ' } })).status, 400);
  r = await call(R.brand.PUT, { method: 'PUT', params: { id: String(brandId) }, body: { colors: 'Navy', tone: 'Bold' } });
  assert.equal(r.status, 200);
  r = await call(R.brand.GET, { params: { id: String(brandId) } });
  assert.equal(r.body.brand.colors, 'Navy');
  const form = new FormData();
  form.append('file', png('logo.png'));
  r = await call(R.logo.POST, { method: 'POST', params: { id: String(brandId) }, form });
  assert.equal(r.status, 200);
  assert.match(r.body.logo, /^logos\/.+\.png$/);
  const bad = new FormData();
  bad.append('file', new File(['x'], 'a.gif', { type: 'image/gif' }));
  assert.equal((await call(R.logo.POST, { method: 'POST', params: { id: String(brandId) }, form: bad })).status, 400);
  assert.equal((await call(R.brand.GET, { params: { id: '999' } })).status, 404);
});

await test('product: create with 4 default slots, photo limits, file serving', async () => {
  let r = await call(R.products.POST, { method: 'POST', body: { name: 'Bottle', brand_id: brandId } });
  pid = r.body.id;
  assert.equal((await call(R.products.POST, { method: 'POST', body: { name: 'X', brand_id: 999 } })).status, 400);
  let t = await tree(pid);
  slots = t.slots;
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((s) => s.type), ['features', 'benefits', 'dimensions', 'how_to_use']);

  const form = new FormData();
  form.append('files', png('a.png'));
  r = await call(R.productAct.POST, { method: 'POST', params: { id: String(pid), action: 'photos' }, form });
  assert.equal(r.body.photos.length, 1);
  const more = new FormData();
  for (const x of ['b', 'c', 'd']) more.append('files', png(x + '.png'));
  r = await call(R.productAct.POST, { method: 'POST', params: { id: String(pid), action: 'photos' }, form: more });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at most 3/);

  t = await tree(pid);
  const rel = t.product.photos[0].split('/');
  const served = await call(R.files.GET, { params: { path: rel } });
  assert.equal(served.status, 200);
  assert.equal(served.type, 'image/png');
  assert.equal((await call(R.files.GET, { params: { path: ['..', '..', 'etc', 'passwd'] } })).status, 400);
});

await test('product edit, add slot, delete slot', async () => {
  let r = await call(R.product.PUT, { method: 'PUT', params: { id: String(pid) }, body: { details: '750ml', max_retries: 9 } });
  assert.equal(r.status, 200);
  let t = await tree(pid);
  assert.equal(t.product.details, '750ml');
  assert.equal(t.product.max_retries, 5, 'retries clamped to 5');
  r = await call(R.productAct.POST, { method: 'POST', params: { id: String(pid), action: 'add-slot' }, body: { type: 'comparison' } });
  assert.equal(r.status, 200);
  assert.equal((await tree(pid)).slots.length, 5);
  assert.equal((await call(R.slot.DELETE, { method: 'DELETE', params: { id: String(r.body.id) } })).status, 200);
  assert.equal((await tree(pid)).slots.length, 4);
  assert.equal((await call(R.productAct.POST, { method: 'POST', params: { id: String(pid), action: 'nope' }, body: {} })).status, 404);
});

await test('slot flow over HTTP: variations -> choose -> redo -> approve', async () => {
  const sid = slots[0].id;
  let r = await call(R.slotAct.POST, { method: 'POST', params: { id: String(sid), action: 'variations' }, body: {} });
  assert.equal(r.status, 400, 'needs a brief first');
  await call(R.slot.PUT, { method: 'PUT', params: { id: String(sid) }, body: { brief: 'Show 4 features' } });
  r = await call(R.slotAct.POST, { method: 'POST', params: { id: String(sid), action: 'variations' }, body: {} });
  assert.equal(r.status, 200);
  let t = await tree(pid);
  assert.equal(t.slots[0].status, 'prompting', 'status is set before the request returns');
  assert.equal((await call(R.slotAct.POST, { method: 'POST', params: { id: String(sid), action: 'variations' }, body: {} })).status, 409);
  t = await waitFor(async () => {
    const x = await tree(pid);
    return x.slots[0].status === 'choose' && x;
  }, 'choose');
  const prompts = t.slots[0].prompts;
  assert.equal(prompts.length, 3);
  r = await call(R.slotAct.POST, { method: 'POST', params: { id: String(sid), action: 'choose' }, body: { promptId: prompts[0].id, text: 'My edit' } });
  assert.equal(r.status, 200);
  t = await waitFor(async () => {
    const x = await tree(pid);
    return x.slots[0].status === 'review' && x;
  }, 'review');
  assert.equal(t.slots[0].images.length, 1);
  assert.equal(t.slots[0].images[0].qc.issues[0].severity, 'warning');
  assert.equal(t.slots[0].images[0].qc.pass, true);
  await call(R.slotAct.POST, { method: 'POST', params: { id: String(sid), action: 'redo' }, body: { note: 'bigger product' } });
  t = await waitFor(async () => {
    const x = await tree(pid);
    return x.slots[0].status === 'review' && x.slots[0].images.length === 2 && x;
  }, 'redo');
  assert.ok(t.slots[0].prompts.some((p) => p.source === 'redo' && p.text === 'Better prompt'));
  r = await call(R.slotAct.POST, { method: 'POST', params: { id: String(sid), action: 'approve' }, body: { imageId: t.slots[0].images[1].id } });
  assert.equal(r.status, 200);
  t = await tree(pid);
  assert.equal(t.slots[0].status, 'approved');
  assert.equal(t.slots[0].images.find((i) => i.approved).id, t.slots[0].images[1].id);
});

await test('auto-start validation and full auto over HTTP', async () => {
  let r = await call(R.productAct.POST, { method: 'POST', params: { id: String(pid), action: 'auto-start' }, body: { mode: 'full' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /brief for image 2/);
  for (const s of slots.slice(1)) await call(R.slot.PUT, { method: 'PUT', params: { id: String(s.id) }, body: { brief: 'brief ' + s.id } });
  r = await call(R.productAct.POST, { method: 'POST', params: { id: String(pid), action: 'auto-start' }, body: { mode: 'full' } });
  assert.equal(r.status, 200);
  assert.equal((await tree(pid)).product.auto_status, 'running');
  // manual actions are blocked while auto runs
  assert.equal((await call(R.slotAct.POST, { method: 'POST', params: { id: String(slots[1].id), action: 'variations' }, body: {} })).status, 409);
  const t = await waitFor(async () => {
    const x = await tree(pid);
    return x.product.auto_status === 'done' && x;
  }, 'auto done', 15000);
  assert.ok(t.slots.every((s) => s.status === 'approved'));
  assert.match(t.product.auto_message, /4 approved/);
});

await test('templates API: read, edit with warning, brand override, reset, test', async () => {
  let r = await call(R.templates.GET, { url: 'http://localhost/api/templates?scope=global' });
  assert.equal(Object.keys(r.body.templates).length, 4);
  assert.equal(r.body.templates.variations.source, 'default');
  assert.ok(r.body.placeholders.length > 10);
  assert.ok(r.body.testTargets.length >= 4);
  assert.match(r.body.templates.qc.locked, /"pass"/);

  r = await call(R.templates.PUT, { method: 'PUT', body: { scope: 'global', key: 'variations', content: 'Hello {{brand_name}} {{bogus}}' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.warnings, ['bogus']);
  assert.equal((await call(R.templates.PUT, { method: 'PUT', body: { scope: 'global', key: 'variations', content: '  ' } })).status, 400);
  assert.equal((await call(R.templates.PUT, { method: 'PUT', body: { scope: 'global', key: 'nope', content: 'x' } })).status, 400);

  r = await call(R.templates.GET, { url: `http://localhost/api/templates?scope=brand:${brandId}` });
  assert.equal(r.body.templates.variations.source, 'global', 'brand inherits the global edit');
  await call(R.templates.PUT, { method: 'PUT', body: { scope: `brand:${brandId}`, key: 'variations', content: 'Brand only' } });
  r = await call(R.templates.GET, { url: `http://localhost/api/templates?scope=brand:${brandId}` });
  assert.equal(r.body.templates.variations.source, 'brand');
  await call(R.templates.POST, { method: 'POST', body: { action: 'reset', scope: `brand:${brandId}`, key: 'variations' } });
  r = await call(R.templates.GET, { url: `http://localhost/api/templates?scope=brand:${brandId}` });
  assert.equal(r.body.templates.variations.source, 'global', 'removing the override falls back to global');
  assert.equal(r.body.templates.variations.history.length, 2);

  await call(R.templates.POST, { method: 'POST', body: { action: 'reset', scope: 'global', key: 'variations' } });
  r = await call(R.templates.GET, { url: 'http://localhost/api/templates?scope=global' });
  assert.match(r.body.templates.variations.content, /senior Amazon listing designer/);

  r = await call(R.templates.POST, { method: 'POST', body: { action: 'test', slotId: slots[0].id, content: r.body.templates.variations.content } });
  assert.equal(r.status, 200);
  assert.equal(r.body.variations.length, 3);
  assert.equal((await call(R.templates.GET, { url: 'http://localhost/api/templates?scope=brand:999' })).status, 400);
});

await test('dashboard summary: stats, brand folders, product cards, recent images', async () => {
  const r = await call(R.dashboard.GET);
  assert.equal(r.status, 200);
  const d = r.body;
  assert.equal(d.stats.brands, 1);
  assert.equal(d.stats.products, 1);
  assert.equal(d.stats.slots, 4);
  assert.equal(d.stats.approved, 4);
  assert.equal(d.stats.attention, 0);
  assert.equal(d.stats.running, 0);
  assert.equal(d.brands[0].productCount, 1);
  assert.equal(d.brands[0].approved, 4);
  assert.equal(d.brands[0].thumbs.length, 4);
  assert.ok(d.brands[0].logo, 'logo path included');
  assert.equal(d.products[0].slots.length, 4);
  assert.equal(d.products[0].thumbs.length, 4);
  assert.ok(d.products[0].photo, 'first reference photo included');
  assert.equal(d.products[0].brand, 'Acme');
  assert.equal(d.recent.length, 4);
  assert.equal(typeof d.setup.anthropic, 'boolean');
  // an image waiting for review shows up in the attention list
  await call(R.slotAct.POST, { method: 'POST', params: { id: String(slots[2].id), action: 'redo' }, body: {} });
  await waitFor(async () => (await call(R.dashboard.GET)).body.stats.attention === 1, 'attention');
  const a = (await call(R.dashboard.GET)).body;
  assert.equal(a.attention[0].product, 'Bottle');
  assert.equal(a.attention[0].status, 'review');
  assert.equal(a.stats.approved, 3, 'a slot being redone counts as needing review, not approved');
});

await test('delete product and brand', async () => {
  assert.equal((await call(R.product.DELETE, { method: 'DELETE', params: { id: String(pid) } })).status, 200);
  assert.equal((await call(R.product.GET, { params: { id: String(pid) } })).status, 404);
  assert.equal((await call(R.brand.DELETE, { method: 'DELETE', params: { id: String(brandId) } })).status, 200);
});

let failed = 0;
for (const [s, t] of results) {
  console.log(s, t);
  if (s === 'FAIL') failed++;
}
console.log(failed ? `\n${failed} FAILED` : '\nAll API tests passed');
process.exit(failed ? 1 : 0);
