// Core-logic test with a fake AI and a temporary database. Run: node scripts/test-core.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'infographic-test-'));

const { all, get, run, now, insertId, saveFile } = await import('../lib/db.js');
const T = await import('../lib/templates.js');
const { ai } = await import('../lib/ai.js');
const P = await import('../lib/pipeline.js');

// ---------- fake AI ----------
const claudeCalls = [];
let qcFailuresLeft = 0;
let imageCount = 0;
ai.prepImage = async () => ({ mime: 'image/png', data: 'AAAA' });
ai.generateImageGemini = async (prompt, refs) => {
  imageCount += 1;
  ai.lastImagePrompt = prompt;
  ai.lastImageRefs = refs.length;
  return { buf: Buffer.from('fake-png-' + imageCount), mime: 'image/png' };
};
ai.askClaude = async (text, images) => {
  claudeCalls.push({ text, images: images.length });
  if (text.includes('"variations":[{"label"')) {
    const n = Number(/exactly (\d+) item/.exec(text)[1]);
    const variations = Array.from({ length: n }, (_, i) => ({ label: `Concept ${i + 1}`, prompt: `Prompt text ${i + 1} "HELLO"` }));
    return JSON.stringify({ variations, recommended: n - 1 });
  }
  if (text.includes('{"prompt":"the complete new')) return '```json\n' + JSON.stringify({ prompt: 'Improved prompt' }) + '\n```';
  if (text.includes('"pass":true')) {
    if (qcFailuresLeft > 0) {
      qcFailuresLeft -= 1;
      return JSON.stringify({ pass: true, summary: 'bad', issues: [{ severity: 'error', category: 'spelling', message: 'Headline misspelled' }] });
    }
    return JSON.stringify({ pass: true, summary: 'good', issues: [] });
  }
  if (text.includes('style specification as plain text')) return 'Dark navy gradient background, white bold sans-serif headlines.';
  throw new Error('unexpected claude call');
};

// ---------- helpers ----------
const waitFor = async (fn, what, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for ' + what);
};
const slotStatus = (id) => get('SELECT status FROM slots WHERE id=?', id).status;
const autoStatus = (id) => get('SELECT auto_status FROM products WHERE id=?', id).auto_status;

function makeProduct(brandId, nSlots, { photos = true } = {}) {
  const photo = saveFile(Buffer.from('photo'), 'png', 'uploads');
  const pid = insertId(
    run('INSERT INTO products (brand_id,name,details,photos,max_retries,created_at) VALUES (?,?,?,?,?,?)', brandId, 'Steel Bottle', '750ml, steel', JSON.stringify(photos ? [photo] : []), 2, now())
  );
  const slotIds = [];
  for (let i = 0; i < nSlots; i++) {
    slotIds.push(insertId(run('INSERT INTO slots (product_id,position,type,brief) VALUES (?,?,?,?)', pid, i, ['features', 'benefits', 'dimensions'][i % 3], `Brief ${i + 1}`)));
  }
  return { pid, slotIds };
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

const brandId = insertId(
  run('INSERT INTO brands (name,colors,fonts,tone,dos,donts,notes,created_at) VALUES (?,?,?,?,?,?,?,?)', 'Acme', 'Navy #0B1F4B', 'Montserrat', 'Confident', 'Use icons', 'No stars', '', now())
);

// ---------- tests ----------
await test('templates: default, global edit, brand override, inherit, reset', () => {
  assert.equal(T.getTemplate('variations', brandId).source, 'default');
  T.saveTemplate('global', 'variations', 'GLOBAL {{brand_name}}');
  assert.equal(T.getTemplate('variations', brandId).version, 'global:v1');
  T.saveTemplate('brand:' + brandId, 'variations', 'BRAND {{brand_name}}');
  assert.equal(T.getTemplate('variations', brandId).content, 'BRAND {{brand_name}}');
  T.saveTemplate('brand:' + brandId, 'variations', ''); // empty = inherit
  assert.equal(T.getTemplate('variations', brandId).source, 'global');
  T.saveTemplate('global', 'variations', T.DEFAULTS.variations); // reset to default content
  assert.equal(T.templateHistory('global', 'variations').length, 2);
  assert.deepEqual(T.unknownPlaceholders('{{brand_name}} {{nope}} {{ also_bad }}'), ['nope', 'also_bad']);
  assert.equal(T.fillTemplate('{{a}} {{b}}', { a: 1 }), '1 {{b}}');
  for (const k of T.TEMPLATE_KEYS) assert.deepEqual(T.unknownPlaceholders(T.DEFAULTS[k]), [], 'default ' + k + ' uses only known placeholders');
});

await test('manual flow: variations -> choose -> image + QC -> redo with note -> approve', async () => {
  const { pid, slotIds } = makeProduct(brandId, 1);
  const [sid] = slotIds;
  P.actVariations(sid);
  await waitFor(() => slotStatus(sid) === 'choose', 'choose');
  const prompts = all('SELECT * FROM prompts WHERE slot_id=? ORDER BY id', sid);
  assert.equal(prompts.length, 3);
  assert.equal(prompts.filter((p) => p.recommended).length, 1);
  assert.ok(!claudeCalls.at(-1).text.includes('{{'), 'no unfilled placeholders sent to Claude');
  assert.ok(claudeCalls.at(-1).text.includes('Navy #0B1F4B'), 'brand data included');

  P.actChoose(sid, prompts[1].id, 'Edited prompt text');
  await waitFor(() => slotStatus(sid) === 'review', 'review');
  let imgs = all('SELECT * FROM images WHERE slot_id=?', sid);
  assert.equal(imgs.length, 1);
  assert.equal(JSON.parse(imgs[0].qc).pass, true);
  assert.ok(ai.lastImagePrompt.includes('Edited prompt text'), 'edited text used for image');
  assert.ok(ai.lastImagePrompt.includes('REFERENCE IMAGES ATTACHED'));

  P.actRedo(sid, 'product too small');
  await waitFor(() => slotStatus(sid) === 'review' && all('SELECT id FROM images WHERE slot_id=?', sid).length === 2, 'redo image');
  const redoCall = claudeCalls.filter((c) => c.text.includes('WHAT NEEDS TO CHANGE')).at(-1);
  assert.ok(redoCall.text.includes('product too small'));
  assert.ok(redoCall.text.includes('Edited prompt text'), 'old prompt passed to redo');
  assert.ok(redoCall.images >= 2, 'previous generated image + references sent to Claude');
  const redoPrompt = get("SELECT * FROM prompts WHERE slot_id=? AND source='redo'", sid);
  assert.equal(redoPrompt.text, 'Improved prompt');
  assert.ok(redoPrompt.template_version, 'template version recorded on the prompt');
  assert.equal(get('SELECT selected_prompt_id s FROM slots WHERE id=?', sid).s, redoPrompt.id);

  P.actApprove(sid);
  assert.equal(slotStatus(sid), 'approved');
  assert.equal(all('SELECT * FROM images WHERE slot_id=? AND approved=1', sid).length, 1);
  assert.equal(P.getProductTree(pid).slots[0].images.length, 2);
});

await test('guards: no photo, busy slot, empty brief', async () => {
  const { slotIds } = makeProduct(brandId, 1, { photos: false });
  P.actVariations(slotIds[0]);
  await waitFor(() => slotStatus(slotIds[0]) === 'error', 'error');
  assert.match(get('SELECT message FROM slots WHERE id=?', slotIds[0]).message, /product photo/);

  const { slotIds: s2 } = makeProduct(brandId, 1);
  P.actVariations(s2[0]);
  assert.throws(() => P.actVariations(s2[0]), /already being worked on/);
  await waitFor(() => slotStatus(s2[0]) === 'choose', 'choose');

  run("UPDATE slots SET brief='' WHERE id=?", s2[0]);
  assert.throws(() => P.actVariations(s2[0]), /brief/);
});

await test('full auto: all slots, QC retry, approved, per-product', async () => {
  const a = makeProduct(brandId, 2);
  const other = makeProduct(brandId, 1);
  qcFailuresLeft = 1; // first image fails QC once, then passes
  P.startAuto(a.pid, 'full');
  assert.equal(autoStatus(a.pid), 'running');
  await waitFor(() => autoStatus(a.pid) === 'done', 'auto done', 15000);
  for (const sid of a.slotIds) assert.equal(slotStatus(sid), 'approved');
  assert.equal(all('SELECT * FROM images WHERE slot_id=?', a.slotIds[0]).length, 2, 'one retry on first slot');
  assert.ok(get('SELECT auto_message m FROM products WHERE id=?', a.pid).m.includes('2 approved'));
  assert.equal(slotStatus(other.slotIds[0]), 'empty', 'other product untouched');
  assert.equal(all("SELECT * FROM prompts WHERE slot_id=? AND source='variation'", a.slotIds[0]).length, 3, 'no style yet: 3 variations');
  assert.throws(() => P.startAuto(a.pid, 'full') || P.actVariations(a.slotIds[0]), /./);
});

await test('auto stops retrying after N and flags for review', async () => {
  const a = makeProduct(brandId, 1);
  run('UPDATE products SET max_retries=1 WHERE id=?', a.pid);
  qcFailuresLeft = 99;
  P.startAuto(a.pid, 'full');
  await waitFor(() => autoStatus(a.pid) === 'done', 'auto done');
  qcFailuresLeft = 0;
  assert.equal(slotStatus(a.slotIds[0]), 'review');
  assert.equal(all('SELECT * FROM images WHERE slot_id=?', a.slotIds[0]).length, 2, '1 original + 1 retry');
  assert.match(get('SELECT auto_message m FROM products WHERE id=?', a.pid).m, /need your review/);
});

await test('auto with fine-tune: anchor first, then others in locked style', async () => {
  const a = makeProduct(brandId, 3);
  const [anchor, s2, s3] = a.slotIds;
  P.startAuto(a.pid, 'finetune', anchor);
  assert.equal(autoStatus(a.pid), 'awaiting_anchor');
  await waitFor(() => slotStatus(anchor) === 'choose', 'anchor variations');
  assert.equal(slotStatus(s2), 'empty', 'others wait');
  const pr = all('SELECT * FROM prompts WHERE slot_id=?', anchor);
  assert.equal(pr.length, 3);

  P.actChoose(anchor, pr[0].id);
  await waitFor(() => slotStatus(anchor) === 'review', 'anchor image');
  assert.equal(slotStatus(s2), 'empty');
  P.actApprove(anchor);

  await waitFor(() => autoStatus(a.pid) === 'done', 'fine-tune done', 15000);
  assert.match(get('SELECT style_spec s FROM products WHERE id=?', a.pid).s, /navy/i);
  for (const sid of [s2, s3]) {
    assert.equal(slotStatus(sid), 'approved');
    assert.equal(all("SELECT * FROM prompts WHERE slot_id=? AND source='variation'", sid).length, 1, 'locked style: 1 prompt per slot');
  }
  assert.equal(ai.lastImageRefs, 2, 'product photo + anchor image sent as references');
  assert.ok(ai.lastImagePrompt.includes('approved infographic from the same set'), 'style reference explained to the image model');
  const lastVar = claudeCalls.filter((c) => c.text.includes('LOCKED STYLE')).at(-1).text;
  assert.ok(lastVar.includes('Dark navy gradient'), 'style spec injected into later prompts');

  // redo anchor, then restyle the others
  P.actRedo(anchor, 'brighter');
  await waitFor(() => slotStatus(anchor) === 'review' && all('SELECT id FROM images WHERE slot_id=?', anchor).length === 2, 'anchor redo');
  P.actApprove(anchor);
  P.restyleOthers(a.pid);
  await waitFor(() => autoStatus(a.pid) === 'done', 'restyle done', 15000);
  assert.equal(all('SELECT * FROM images WHERE slot_id=?', s2).length, 2, 'other slot regenerated');
});

await test('stop auto', async () => {
  const a = makeProduct(brandId, 3);
  P.startAuto(a.pid, 'full');
  P.stopAuto(a.pid);
  await waitFor(() => ['stopped', 'done'].includes(autoStatus(a.pid)), 'stop', 15000);
  assert.equal(autoStatus(a.pid), 'stopped');
});

let failed = 0;
for (const [s, n] of results) {
  console.log(s, n);
  if (s === 'FAIL') failed++;
}
console.log(failed ? `\n${failed} FAILED` : '\nAll core tests passed');
process.exit(failed ? 1 : 0);
