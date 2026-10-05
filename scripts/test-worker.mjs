// End-to-end test of worker.js through its HTTP routes, with D1 emulated on node:sqlite
// and fake Claude/Gemini. Run: node scripts/test-worker.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import worker from '../worker.js';

// ---------- D1 stand-in ----------
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON;');
const stmt = (sql, params = []) => ({
  bind: (...p) => stmt(sql, p),
  all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
  first: async () => sqlite.prepare(sql).get(...params) ?? null,
  run: async () => ({ meta: { last_row_id: Number(sqlite.prepare(sql).run(...params).lastInsertRowid) } }),
});
const DB = { prepare: (sql) => stmt(sql), batch: (list) => Promise.all(list.map((s) => s.run())) };
const q = (sql, ...p) => sqlite.prepare(sql).all(...p);
const q1 = (sql, ...p) => sqlite.prepare(sql).get(...p);

const env = { DB, ANTHROPIC_API_KEY: 'test', GEMINI_API_KEY: 'test', APP_PASSWORD: '' };

// ---------- fake AI ----------
const claudeCalls = [];
let qcFailuresLeft = 0;
let imageCount = 0;
let lastImage = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).includes('anthropic.com')) {
    const content = body.messages[0].content;
    const text = content.at(-1).text;
    claudeCalls.push({ text, images: content.length - 1 });
    const reply = (t) => new Response(JSON.stringify({ content: [{ type: 'text', text: t }] }));
    if (text.includes('"variations":[{"label"')) {
      const n = Number(/exactly (\d+) item/.exec(text)[1]);
      const variations = Array.from({ length: n }, (_, i) => ({ label: `Concept ${i + 1}`, prompt: `Prompt text ${i + 1} "HELLO"` }));
      return reply(JSON.stringify({ variations, recommended: n - 1 }));
    }
    if (text.includes('{"prompt":"the complete new')) return reply('```json\n' + JSON.stringify({ prompt: 'Improved prompt' }) + '\n```');
    if (text.includes('"pass":true')) {
      if (qcFailuresLeft > 0) {
        qcFailuresLeft -= 1;
        return reply(JSON.stringify({ pass: true, summary: 'bad', issues: [{ severity: 'error', category: 'spelling', message: 'Headline misspelled' }] }));
      }
      return reply(JSON.stringify({ pass: true, summary: 'good', issues: [] }));
    }
    if (text.includes('style specification as plain text')) return reply('Dark navy gradient background, white bold sans-serif headlines.');
    throw new Error('unexpected claude call');
  }
  if (String(url).includes('googleapis.com')) {
    imageCount += 1;
    const parts = body.contents[0].parts;
    lastImage = { prompt: parts[0].text, refs: parts.length - 1 };
    const data = Buffer.from('fake-png-' + imageCount).toString('base64');
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }] }));
  }
  return realFetch(url, init);
};

// ---------- helpers ----------
async function call(method, path, body, e = env, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await worker.fetch(new Request('http://localhost' + path, init), e);
  if (res.headers.get('x-background')) {
    res.text(); // drain like the browser does; the job keeps running
    return { status: res.status, data: { ok: true }, res };
  }
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : null, res };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 400) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
const waitFor = async (fn, what, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for ' + what);
};
const slotStatus = (id) => q1('SELECT status FROM slots WHERE id=?', id).status;
const autoStatus = (id) => q1('SELECT auto_status FROM products WHERE id=?', id).auto_status;

async function makeProduct(brandId, nSlots, { photos = true } = {}) {
  const { id: pid } = await ok('POST', '/api/products', { name: 'Steel Bottle', brand_id: brandId });
  await ok('PUT', `/api/products/${pid}`, { details: '750ml, steel', max_retries: 2 });
  if (photos) {
    const form = new FormData();
    form.append('files', new File([Buffer.from('photo')], 'p.png', { type: 'image/png' }));
    await ok('POST', `/api/products/${pid}/photos`, form);
  }
  const slotIds = q('SELECT id FROM slots WHERE product_id=? ORDER BY position', pid).map((s) => s.id);
  for (const id of slotIds.slice(nSlots)) await ok('DELETE', `/api/slots/${id}`);
  for (const [i, id] of slotIds.slice(0, nSlots).entries()) await ok('PUT', `/api/slots/${id}`, { brief: `Brief ${i + 1}` });
  return { pid, slotIds: slotIds.slice(0, nSlots) };
}

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name + ' -> ' + (e.stack || e.message)]);
  }
};

const { id: brandId } = await ok('POST', '/api/brands', { name: 'Acme' });
await ok('PUT', `/api/brands/${brandId}`, { colors: 'Navy #0B1F4B', fonts: 'Montserrat', tone: 'Confident', dos: 'Use icons', donts: 'No stars' });

// ---------- tests ----------
await test('templates are stored in D1: a save is seen by every later request', async () => {
  let t = await ok('GET', `/api/templates?scope=brand:${brandId}`);
  assert.equal(t.templates.variations.source, 'default');
  await ok('PUT', '/api/templates', { scope: 'global', key: 'variations', content: 'GLOBAL {{brand_name}}' });
  t = await ok('GET', '/api/templates?scope=global');
  assert.equal(t.templates.variations.content, 'GLOBAL {{brand_name}}');
  assert.equal(t.templates.variations.version, 'global:v1');
  await ok('PUT', '/api/templates', { scope: `brand:${brandId}`, key: 'variations', content: 'BRAND {{nope}}' });
  t = await ok('GET', `/api/templates?scope=brand:${brandId}`);
  assert.equal(t.templates.variations.source, 'brand');
  assert.deepEqual(t.templates.variations.warnings, ['nope']);
  await ok('POST', '/api/templates', { action: 'reset', scope: `brand:${brandId}`, key: 'variations' }); // inherit
  await ok('POST', '/api/templates', { action: 'reset', scope: 'global', key: 'variations' });
  t = await ok('GET', `/api/templates?scope=brand:${brandId}`);
  assert.equal(t.templates.variations.source, 'global');
  assert.equal((await ok('GET', '/api/templates?scope=global')).templates.variations.history.length, 2);
  assert.equal((await call('PUT', '/api/templates', { scope: 'global', key: 'qc', content: ' ' })).status, 400);
});

await test('manual flow: variations -> choose -> image + QC -> redo with note -> approve -> export', async () => {
  const { pid, slotIds } = await makeProduct(brandId, 1);
  const [sid] = slotIds;
  await ok('POST', `/api/slots/${sid}/variations`);
  await waitFor(() => slotStatus(sid) === 'choose', 'choose');
  const prompts = q('SELECT * FROM prompts WHERE slot_id=? ORDER BY id', sid);
  assert.equal(prompts.length, 3);
  assert.equal(prompts.filter((p) => p.recommended).length, 1);
  assert.ok(!claudeCalls.at(-1).text.includes('{{'), 'no unfilled placeholders sent to Claude');
  assert.ok(claudeCalls.at(-1).text.includes('Navy #0B1F4B'), 'brand data included');

  await ok('POST', `/api/slots/${sid}/choose`, { promptId: prompts[1].id, text: 'Edited prompt text' });
  await waitFor(() => slotStatus(sid) === 'review', 'review');
  const imgs = q('SELECT * FROM images WHERE slot_id=?', sid);
  assert.equal(imgs.length, 1);
  assert.equal(JSON.parse(imgs[0].qc).pass, true);
  assert.ok(lastImage.prompt.includes('Edited prompt text'), 'edited text used for image');
  assert.ok(lastImage.prompt.includes('REFERENCE IMAGES ATTACHED'));

  const file = await call('GET', `/api/files/${imgs[0].path}`);
  assert.equal(Buffer.from(await file.res.arrayBuffer()).toString(), 'fake-png-' + imageCount);
  assert.equal(file.res.headers.get('content-type'), 'image/png');

  await ok('POST', `/api/slots/${sid}/redo`, { note: 'product too small' });
  await waitFor(() => slotStatus(sid) === 'review' && q('SELECT id FROM images WHERE slot_id=?', sid).length === 2, 'redo image');
  const redoCall = claudeCalls.filter((c) => c.text.includes('WHAT NEEDS TO CHANGE')).at(-1);
  assert.ok(redoCall.text.includes('product too small'));
  assert.ok(redoCall.text.includes('Edited prompt text'), 'old prompt passed to redo');
  assert.ok(redoCall.images >= 2, 'previous generated image + references sent to Claude');
  const redoPrompt = q1("SELECT * FROM prompts WHERE slot_id=? AND source='redo'", sid);
  assert.equal(redoPrompt.text, 'Improved prompt');
  assert.ok(redoPrompt.template_version);

  await ok('POST', `/api/slots/${sid}/approve`);
  assert.equal(slotStatus(sid), 'approved');
  const tree = await ok('GET', `/api/products/${pid}`);
  assert.equal(tree.slots[0].images.length, 2);
  assert.equal(tree.slots[0].prompts.length, 4);

  const zipRes = await call('GET', `/api/products/${pid}/export`);
  const z = await JSZip.loadAsync(await zipRes.res.arrayBuffer());
  const names = Object.keys(z.files);
  assert.equal(names.length, 2);
  assert.match(await z.file('prompts.txt').async('string'), /Improved prompt/);
  assert.match(await z.file(names.find((n) => n.endsWith('.png'))).async('string'), /^fake-png-/);
});

await test('guards: no photo, busy slot, empty brief', async () => {
  const { slotIds } = await makeProduct(brandId, 1, { photos: false });
  await ok('POST', `/api/slots/${slotIds[0]}/variations`);
  await waitFor(() => slotStatus(slotIds[0]) === 'error', 'error');
  assert.match(q1('SELECT message FROM slots WHERE id=?', slotIds[0]).message, /product photo/);

  const { slotIds: s2 } = await makeProduct(brandId, 1);
  await ok('POST', `/api/slots/${s2[0]}/variations`);
  const again = await call('POST', `/api/slots/${s2[0]}/variations`);
  assert.equal(again.status, 409);
  await waitFor(() => slotStatus(s2[0]) === 'choose', 'choose');

  await ok('PUT', `/api/slots/${s2[0]}`, { brief: '' });
  assert.match((await call('POST', `/api/slots/${s2[0]}/variations`)).data.error, /brief/);
});

await test('large files are split across D1 rows and read back intact', async () => {
  const { pid } = await makeProduct(brandId, 1, { photos: false });
  const big = Buffer.alloc(1_900_000, 7); // base64 > 2 chunks
  const form = new FormData();
  form.append('files', new File([big], 'big.jpg', { type: 'image/jpeg' }));
  const { photos } = await ok('POST', `/api/products/${pid}/photos`, form);
  assert.equal(q1('SELECT COUNT(*) c FROM files WHERE path=?', photos[0]).c, 3);
  const back = Buffer.from(await (await call('GET', `/api/files/${photos[0]}`)).res.arrayBuffer());
  assert.ok(back.equals(big));
  await ok('POST', `/api/products/${pid}/delete-photo`, { path: photos[0] });
  assert.equal(q1('SELECT COUNT(*) c FROM files WHERE path=?', photos[0]).c, 0);
});

await test('full auto: all slots, QC retry, approved, per-product', async () => {
  const a = await makeProduct(brandId, 2);
  const other = await makeProduct(brandId, 1);
  qcFailuresLeft = 1; // first image fails QC once, then passes
  await ok('POST', `/api/products/${a.pid}/auto-start`, { mode: 'full' });
  assert.equal(autoStatus(a.pid), 'running');
  await waitFor(() => autoStatus(a.pid) === 'done', 'auto done', 15000);
  for (const sid of a.slotIds) assert.equal(slotStatus(sid), 'approved');
  assert.equal(q('SELECT * FROM images WHERE slot_id=?', a.slotIds[0]).length, 2, 'one retry on first slot');
  assert.ok(q1('SELECT auto_message m FROM products WHERE id=?', a.pid).m.includes('2 approved'));
  assert.equal(slotStatus(other.slotIds[0]), 'empty', 'other product untouched');
  assert.equal(q("SELECT * FROM prompts WHERE slot_id=? AND source='variation'", a.slotIds[0]).length, 3);
});

await test('auto stops retrying after N and flags for review', async () => {
  const a = await makeProduct(brandId, 1);
  await ok('PUT', `/api/products/${a.pid}`, { max_retries: 1 });
  qcFailuresLeft = 99;
  await ok('POST', `/api/products/${a.pid}/auto-start`, { mode: 'full' });
  await waitFor(() => autoStatus(a.pid) === 'done', 'auto done');
  qcFailuresLeft = 0;
  assert.equal(slotStatus(a.slotIds[0]), 'review');
  assert.equal(q('SELECT * FROM images WHERE slot_id=?', a.slotIds[0]).length, 2, '1 original + 1 retry');
  assert.match(q1('SELECT auto_message m FROM products WHERE id=?', a.pid).m, /need your review/);
});

await test('auto with fine-tune: anchor first, then others in locked style', async () => {
  const a = await makeProduct(brandId, 3);
  const [anchor, s2, s3] = a.slotIds;
  await ok('POST', `/api/products/${a.pid}/auto-start`, { mode: 'finetune', anchorSlotId: anchor });
  assert.equal(autoStatus(a.pid), 'awaiting_anchor');
  await waitFor(() => slotStatus(anchor) === 'choose', 'anchor variations');
  assert.equal(slotStatus(s2), 'empty', 'others wait');
  const pr = q('SELECT * FROM prompts WHERE slot_id=?', anchor);

  await ok('POST', `/api/slots/${anchor}/choose`, { promptId: pr[0].id });
  await waitFor(() => slotStatus(anchor) === 'review', 'anchor image');
  await ok('POST', `/api/slots/${anchor}/approve`);

  await waitFor(() => autoStatus(a.pid) === 'done', 'fine-tune done', 15000);
  assert.match(q1('SELECT style_spec s FROM products WHERE id=?', a.pid).s, /navy/i);
  for (const sid of [s2, s3]) {
    assert.equal(slotStatus(sid), 'approved');
    assert.equal(q("SELECT * FROM prompts WHERE slot_id=? AND source='variation'", sid).length, 1, 'locked style: 1 prompt per slot');
  }
  assert.equal(lastImage.refs, 2, 'product photo + anchor image sent as references');
  assert.ok(lastImage.prompt.includes('approved infographic from the same set'));

  await ok('POST', `/api/slots/${anchor}/redo`, { note: 'brighter' });
  await waitFor(() => slotStatus(anchor) === 'review' && q('SELECT id FROM images WHERE slot_id=?', anchor).length === 2, 'anchor redo');
  await ok('POST', `/api/slots/${anchor}/approve`);
  await ok('POST', `/api/products/${a.pid}/restyle`);
  await waitFor(() => autoStatus(a.pid) === 'done', 'restyle done', 15000);
  assert.equal(q('SELECT * FROM images WHERE slot_id=?', s2).length, 2, 'other slot regenerated');
});

await test('stop auto', async () => {
  const a = await makeProduct(brandId, 3);
  await ok('POST', `/api/products/${a.pid}/auto-start`, { mode: 'full' });
  await ok('POST', `/api/products/${a.pid}/auto-stop`);
  await waitFor(() => ['stopped', 'done'].includes(autoStatus(a.pid)), 'stop', 15000);
  assert.equal(autoStatus(a.pid), 'stopped');
});

await test('interrupted jobs (tab closed) are released after 10 minutes', async () => {
  const { pid, slotIds } = await makeProduct(brandId, 1);
  const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  sqlite.prepare("UPDATE slots SET status='generating', beat=? WHERE id=?").run(old, slotIds[0]);
  sqlite.prepare("UPDATE products SET auto_status='running', beat=? WHERE id=?").run(old, pid);
  await ok('GET', `/api/products/${pid}`);
  assert.equal(slotStatus(slotIds[0]), 'error');
  assert.equal(autoStatus(pid), 'stopped');
});

await test('password login protects the API and pages', async () => {
  const locked = { ...env, APP_PASSWORD: 'secret' };
  assert.equal((await call('GET', '/api/dashboard', undefined, locked)).status, 401);
  assert.equal((await call('GET', '/', undefined, locked)).res.status, 302);
  assert.equal((await call('POST', '/api/login', { password: 'nope' }, locked)).status, 401);
  const login = await call('POST', '/api/login', { password: 'secret' }, locked);
  const session = login.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/dashboard', undefined, locked, { cookie: session })).status, 200);
  assert.equal((await call('GET', '/app.js', undefined, locked)).res.status, 200);
});

await test('serves the UI shell for app routes', async () => {
  const r = await call('GET', '/products/1');
  assert.match(await r.res.text(), /<div id="root">/);
  const d = await ok('GET', '/api/dashboard');
  assert.ok(d.stats.products > 0);
});

let failed = 0;
for (const [s, n] of results) {
  console.log(s, n);
  if (s === 'FAIL') failed++;
}
console.log(failed ? `\n${failed} FAILED` : '\nAll worker tests passed');
process.exit(failed ? 1 : 0);
