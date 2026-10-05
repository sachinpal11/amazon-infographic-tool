import { all, get, run, now, insertId, readFile, saveFile } from './db.js';
import { getTemplate, buildPrompt, SLOT_TYPES } from './templates.js';
import { ai, parseJson } from './ai.js';
import { HttpError } from './http.js';

const BUSY = ['prompting', 'generating'];
const msgOf = (e) => (e && e.message) || String(e);
const val = (v) => (v && String(v).trim() ? String(v).trim() : '(not provided)');

export function setSlot(id, status, message = '') {
  run('UPDATE slots SET status=?, message=? WHERE id=?', status, message, id);
}
function setAuto(productId, status, message = '') {
  run('UPDATE products SET auto_status=?, auto_message=? WHERE id=?', status, message, productId);
}
const isCancelled = (productId) => get('SELECT cancel FROM products WHERE id=?', productId)?.cancel === 1;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
function loadCtx(slotId) {
  const slot = get('SELECT * FROM slots WHERE id=?', slotId);
  if (!slot) throw new HttpError(404, 'Slot not found');
  const product = get('SELECT * FROM products WHERE id=?', slot.product_id);
  const brand = get('SELECT * FROM brands WHERE id=?', product.brand_id);
  const slots = all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', product.id);
  return { slot, product, brand, slots };
}

export function varsFor(ctx, extra = {}) {
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
    style_spec: product.style_spec && product.style_spec.trim()
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
  const photos = JSON.parse(product.photos || '[]');
  const imgs = [];
  for (const p of photos) {
    try {
      imgs.push(await ai.prepImage(readFile(p), 1536));
    } catch {
      /* skip unreadable file */
    }
  }
  const photoCount = imgs.length;
  let logo = false;
  if (brand.logo) {
    try {
      imgs.push(await ai.prepImage(readFile(brand.logo), 768));
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

function styleRefRow(ctx) {
  return get(
    `SELECT i.* FROM images i JOIN slots s ON s.id = i.slot_id
     WHERE s.product_id = ? AND s.id <> ? AND i.approved = 1
     ORDER BY (s.id = ?) DESC, s.position ASC, s.id ASC LIMIT 1`,
    ctx.product.id,
    ctx.slot.id,
    ctx.product.anchor_slot_id || 0
  );
}

const selectedPrompt = (slot) =>
  slot.selected_prompt_id ? get('SELECT * FROM prompts WHERE id=?', slot.selected_prompt_id) : null;
const latestImage = (slotId) => get('SELECT * FROM images WHERE slot_id=? ORDER BY id DESC LIMIT 1', slotId);

function insertPrompt(slotId, p) {
  return insertId(
    run(
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

// ---------------------------------------------------------------------------
// Claude steps
// ---------------------------------------------------------------------------
export async function makeVariations(slotId, count = 3) {
  const ctx = loadCtx(slotId);
  const tpl = getTemplate('variations', ctx.brand.id);
  const refs = await productRefs(ctx.product, ctx.brand);
  const text = buildPrompt('variations', tpl.content, varsFor(ctx, { variation_count: String(count) }), describeRefs(refs));
  const parsed = parseJson(await ai.askClaude(text, refs.imgs, 6000));
  const list = (Array.isArray(parsed.variations) ? parsed.variations : [])
    .filter((v) => v && typeof v.prompt === 'string' && v.prompt.trim())
    .slice(0, count);
  if (!list.length) throw new Error('Claude returned no usable prompt variations. Try again.');
  const rec = Number.isInteger(parsed.recommended) && parsed.recommended >= 0 && parsed.recommended < list.length ? parsed.recommended : 0;
  const batch = `b${Date.now()}`;
  const ids = list.map((v, i) =>
    insertPrompt(slotId, {
      text: v.prompt.trim(),
      label: v.label || `Variation ${i + 1}`,
      source: 'variation',
      recommended: i === rec,
      batch,
      templateVersion: tpl.version,
    })
  );
  return { ids, recommendedId: ids[rec] };
}

export async function makeRedoPrompt(slotId, note) {
  const ctx = loadCtx(slotId);
  const prev = selectedPrompt(ctx.slot);
  const last = latestImage(slotId);
  const tpl = getTemplate('redo', ctx.brand.id);
  const refs = await productRefs(ctx.product, ctx.brand);
  const imgs = [];
  let attach = '';
  if (last) {
    imgs.push(await ai.prepImage(readFile(last.path), 1568));
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
  const parsed = parseJson(await ai.askClaude(text, imgs, 4000));
  if (!parsed.prompt || typeof parsed.prompt !== 'string') throw new Error('Claude returned no new prompt. Try again.');
  const id = insertPrompt(slotId, {
    text: parsed.prompt.trim(),
    label: 'Redo',
    source: 'redo',
    templateVersion: tpl.version,
  });
  run('UPDATE slots SET selected_prompt_id=? WHERE id=?', id, slotId);
  return id;
}

async function runQC(ctx, prompt, imagePath, refs) {
  const tpl = getTemplate('qc', ctx.brand.id);
  const imgs = [await ai.prepImage(readFile(imagePath), 1568), ...refs.imgs];
  const attach = 'Image 1: the generated infographic to review.\n' + describeRefs(refs, 2);
  const text = buildPrompt('qc', tpl.content, varsFor(ctx, { generated_prompt: prompt.text }), attach);
  const parsed = parseJson(await ai.askClaude(text, imgs, 2000));
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

export async function makeStyleSpec(productId) {
  const product = get('SELECT * FROM products WHERE id=?', productId);
  const brand = get('SELECT * FROM brands WHERE id=?', product.brand_id);
  const anchor = product.anchor_slot_id
    ? get('SELECT * FROM images WHERE slot_id=? AND approved=1 ORDER BY id DESC LIMIT 1', product.anchor_slot_id)
    : null;
  if (!anchor) throw new Error('The anchor image has not been approved yet.');
  const ctx = loadCtx(product.anchor_slot_id);
  const tpl = getTemplate('style_spec', brand.id);
  const text = buildPrompt('style_spec', tpl.content, varsFor(ctx), 'Image 1: the approved anchor infographic.');
  const spec = (await ai.askClaude(text, [await ai.prepImage(readFile(anchor.path), 1568)], 1500)).trim();
  if (!spec) throw new Error('Claude returned an empty style specification.');
  run('UPDATE products SET style_spec=? WHERE id=?', spec, productId);
  return spec;
}

// ---------------------------------------------------------------------------
// Image generation (+ automatic quality check)
// ---------------------------------------------------------------------------
export async function generateSlotImage(slotId) {
  const ctx = loadCtx(slotId);
  const prompt = selectedPrompt(ctx.slot);
  if (!prompt) throw new HttpError(400, 'Choose a prompt first.');
  setSlot(slotId, 'generating', 'Generating image...');
  const refs = await productRefs(ctx.product, ctx.brand);
  const imgs = [...refs.imgs];
  const styleRow = styleRefRow(ctx);
  if (styleRow) {
    try {
      imgs.push(await ai.prepImage(readFile(styleRow.path), 1536));
    } catch {
      /* ignore */
    }
  }
  const out = await ai.generateImageGemini(imageModelNote(refs, imgs.length > refs.imgs.length) + '\n' + prompt.text, imgs);
  const ext = out.mime.includes('jpeg') ? 'jpg' : out.mime.includes('webp') ? 'webp' : 'png';
  const rel = saveFile(out.buf, ext, 'images');
  const imageId = insertId(
    run('INSERT INTO images (slot_id,prompt_id,path,created_at) VALUES (?,?,?,?)', slotId, prompt.id, rel, now())
  );

  setSlot(slotId, 'generating', 'Checking quality...');
  let qc;
  try {
    qc = await runQC(ctx, prompt, rel, refs);
  } catch (e) {
    qc = { pass: null, summary: '', issues: [], error: 'Quality check could not run: ' + msgOf(e) };
  }
  run('UPDATE images SET qc=? WHERE id=?', JSON.stringify(qc), imageId);
  setSlot(slotId, 'review', '');
  return imageId;
}

export function approveImage(slotId, imageId) {
  const img = get('SELECT * FROM images WHERE id=? AND slot_id=?', imageId, slotId);
  if (!img) throw new HttpError(404, 'Image not found for this slot');
  run('UPDATE images SET approved=0 WHERE slot_id=?', slotId);
  run('UPDATE images SET approved=1 WHERE id=?', imageId);
  run('UPDATE slots SET approved_image_id=?, status=?, message=? WHERE id=?', imageId, 'approved', '', slotId);
}

// ---------------------------------------------------------------------------
// Manual actions (each returns quickly; the work continues in the background)
// ---------------------------------------------------------------------------
function assertIdle(slotId) {
  const s = get('SELECT status, product_id FROM slots WHERE id=?', slotId);
  if (!s) throw new HttpError(404, 'Slot not found');
  if (BUSY.includes(s.status)) throw new HttpError(409, 'This image is already being worked on.');
  const p = get('SELECT auto_status FROM products WHERE id=?', s.product_id);
  if (p.auto_status === 'running') throw new HttpError(409, 'Auto mode is running for this product. Stop it first.');
}

function startJob(slotId, status, message, fn) {
  assertIdle(slotId);
  setSlot(slotId, status, message);
  setImmediate(() => {
    fn().catch((e) => setSlot(slotId, 'error', msgOf(e)));
  });
}

export function actVariations(slotId) {
  const { slot } = loadCtx(slotId);
  if (!slot.brief || !slot.brief.trim()) throw new HttpError(400, 'Write a brief for this image first.');
  startJob(slotId, 'prompting', 'Claude is writing 3 prompt variations...', async () => {
    await makeVariations(slotId, 3);
    setSlot(slotId, 'choose', '');
  });
}

export function actChoose(slotId, promptId, text) {
  assertIdle(slotId);
  const p = get('SELECT * FROM prompts WHERE id=? AND slot_id=?', promptId, slotId);
  if (!p) throw new HttpError(404, 'Prompt not found for this slot');
  if (text && text.trim() && text.trim() !== p.text) {
    run('UPDATE prompts SET text=? WHERE id=?', text.trim(), promptId);
  }
  run('UPDATE slots SET selected_prompt_id=? WHERE id=?', promptId, slotId);
  startJob(slotId, 'generating', 'Generating image...', async () => {
    await generateSlotImage(slotId);
  });
}

export function actGenerate(slotId) {
  const { slot } = loadCtx(slotId);
  if (!slot.selected_prompt_id) throw new HttpError(400, 'Choose a prompt first.');
  startJob(slotId, 'generating', 'Generating image...', async () => {
    await generateSlotImage(slotId);
  });
}

export function actRedo(slotId, note) {
  startJob(slotId, 'generating', 'Claude is writing a new prompt...', async () => {
    await makeRedoPrompt(slotId, note || '');
    await generateSlotImage(slotId);
  });
}

export function actApprove(slotId, imageId) {
  const { slot, product } = loadCtx(slotId);
  if (BUSY.includes(slot.status)) throw new HttpError(409, 'Wait until this image has finished.');
  const id = imageId || latestImage(slotId)?.id;
  if (!id) throw new HttpError(400, 'There is no image to approve.');
  approveImage(slotId, id);
  if (product.auto_status === 'awaiting_anchor' && product.anchor_slot_id === slotId) {
    run('UPDATE products SET cancel=0 WHERE id=?', product.id);
    setAuto(product.id, 'running', 'Reading the approved image to lock its style...');
    setImmediate(() => {
      continueAfterAnchor(product.id, false).catch((e) => setAuto(product.id, 'stopped', msgOf(e)));
    });
  }
}

// ---------------------------------------------------------------------------
// Auto mode
// ---------------------------------------------------------------------------
async function autoSlot(slotId) {
  const first = loadCtx(slotId);
  const productId = first.product.id;
  const count = first.product.style_spec && first.product.style_spec.trim() ? 1 : 3;
  setSlot(slotId, 'prompting', count === 1 ? 'Auto: writing the prompt...' : 'Auto: writing prompts and picking the best...');
  const { recommendedId } = await makeVariations(slotId, count);
  run('UPDATE slots SET selected_prompt_id=? WHERE id=?', recommendedId, slotId);

  const maxRetries = Math.max(0, Number(first.product.max_retries) || 0);
  let imageId = await generateSlotImage(slotId);
  let qc = JSON.parse(get('SELECT qc FROM images WHERE id=?', imageId).qc || 'null');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (!qc || qc.pass !== false) break; // passed, or the check could not run
    if (isCancelled(productId)) break;
    const note =
      'The automatic quality check found these problems. Fix all of them:\n' +
      qc.issues.map((i) => `- [${i.severity}] ${i.category}: ${i.message}`).join('\n');
    setSlot(slotId, 'generating', `Auto retry ${attempt}/${maxRetries}: fixing quality problems...`);
    await makeRedoPrompt(slotId, note);
    imageId = await generateSlotImage(slotId);
    qc = JSON.parse(get('SELECT qc FROM images WHERE id=?', imageId).qc || 'null');
  }

  if (qc && qc.pass === false) {
    setSlot(slotId, 'review', 'Auto mode could not get this image through the quality check. Please review it.');
  } else {
    approveImage(slotId, imageId);
  }
}

async function runAuto(productId, skipSlotId, force) {
  setAuto(productId, 'running', 'Auto mode is running...');
  const slots = all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', productId);
  const todo = slots.filter((s) => s.id !== skipSlotId && (force || s.status !== 'approved'));
  let n = 0;
  for (const s of todo) {
    if (isCancelled(productId)) {
      setAuto(productId, 'stopped', 'Stopped. The image that was in progress finished first.');
      return;
    }
    n += 1;
    setAuto(productId, 'running', `Auto mode: image ${n} of ${todo.length}...`);
    try {
      await autoSlot(s.id);
    } catch (e) {
      setSlot(s.id, 'error', msgOf(e));
    }
  }
  const after = all('SELECT status FROM slots WHERE product_id=?', productId);
  const approved = after.filter((s) => s.status === 'approved').length;
  const review = after.filter((s) => s.status === 'review').length;
  const failed = after.filter((s) => s.status === 'error').length;
  const parts = [`${approved} approved`];
  if (review) parts.push(`${review} need your review`);
  if (failed) parts.push(`${failed} failed`);
  setAuto(productId, 'done', `Auto mode finished: ${parts.join(', ')}.`);
}

async function continueAfterAnchor(productId, force) {
  await makeStyleSpec(productId);
  const product = get('SELECT * FROM products WHERE id=?', productId);
  await runAuto(productId, product.anchor_slot_id, force);
}

function validateAutoStart(productId) {
  const product = get('SELECT * FROM products WHERE id=?', productId);
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.auto_status === 'running') throw new HttpError(409, 'Auto mode is already running.');
  const slots = all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', productId);
  if (!slots.length) throw new HttpError(400, 'Add at least one image slot first.');
  if (slots.some((s) => BUSY.includes(s.status))) throw new HttpError(409, 'Wait until the current work has finished.');
  const missing = slots.findIndex((s) => !s.brief || !s.brief.trim());
  if (missing !== -1) throw new HttpError(400, `Write a brief for image ${missing + 1} first.`);
  if (!JSON.parse(product.photos || '[]').length) throw new HttpError(400, 'Upload at least one product photo first.');
  return { product, slots };
}

export function startAuto(productId, mode, anchorSlotId) {
  const { slots } = validateAutoStart(productId);
  if (mode === 'full') {
    run("UPDATE products SET auto_mode='full', cancel=0 WHERE id=?", productId);
    setAuto(productId, 'running', 'Auto mode is starting...');
    setImmediate(() => {
      runAuto(productId, null, false).catch((e) => setAuto(productId, 'stopped', msgOf(e)));
    });
    return;
  }
  if (mode === 'finetune') {
    const anchor = slots.find((s) => s.id === Number(anchorSlotId)) || slots[0];
    run("UPDATE products SET auto_mode='finetune', anchor_slot_id=?, style_spec='', cancel=0 WHERE id=?", anchor.id, productId);
    if (anchor.status === 'approved') {
      setAuto(productId, 'running', 'Reading the approved image to lock its style...');
      setImmediate(() => {
        continueAfterAnchor(productId, false).catch((e) => setAuto(productId, 'stopped', msgOf(e)));
      });
      return;
    }
    setAuto(
      productId,
      'awaiting_anchor',
      `Step 1: choose a prompt for image ${slots.indexOf(anchor) + 1} (the style anchor), generate it, redo until you like it, then press Approve. The other images follow automatically in that style.`
    );
    if (!anchor.selected_prompt_id || anchor.status === 'empty' || anchor.status === 'error') {
      actVariations(anchor.id);
    }
    return;
  }
  throw new HttpError(400, 'Unknown auto mode');
}

// Re-run every other image in the style of the current anchor (after the anchor changed).
export function restyleOthers(productId) {
  const product = get('SELECT * FROM products WHERE id=?', productId);
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.auto_status === 'running') throw new HttpError(409, 'Auto mode is already running.');
  if (!product.anchor_slot_id) throw new HttpError(400, 'No style anchor is set for this product.');
  const anchor = get('SELECT status FROM slots WHERE id=?', product.anchor_slot_id);
  if (!anchor || anchor.status !== 'approved') throw new HttpError(400, 'Approve the anchor image first.');
  validateAutoStart(productId);
  run('UPDATE products SET cancel=0 WHERE id=?', productId);
  setAuto(productId, 'running', 'Reading the anchor image to lock its style...');
  setImmediate(() => {
    continueAfterAnchor(productId, true).catch((e) => setAuto(productId, 'stopped', msgOf(e)));
  });
}

export function stopAuto(productId) {
  const product = get('SELECT * FROM products WHERE id=?', productId);
  if (!product) throw new HttpError(404, 'Product not found');
  if (product.auto_status === 'running') {
    run('UPDATE products SET cancel=1, auto_message=? WHERE id=?', 'Stopping after the current step...', productId);
  } else if (product.auto_status === 'awaiting_anchor') {
    setAuto(productId, 'idle', '');
  }
}

// ---------------------------------------------------------------------------
// Read model for the UI
// ---------------------------------------------------------------------------
export function getProductTree(productId) {
  const product = get('SELECT * FROM products WHERE id=?', productId);
  if (!product) return null;
  const brand = get('SELECT id, name FROM brands WHERE id=?', product.brand_id);
  const slots = all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', productId).map((s) => ({
    ...s,
    prompts: all('SELECT * FROM prompts WHERE slot_id=? ORDER BY id DESC', s.id),
    images: all('SELECT * FROM images WHERE slot_id=? ORDER BY id DESC', s.id).map((i) => ({
      ...i,
      qc: i.qc ? JSON.parse(i.qc) : null,
    })),
  }));
  return { product: { ...product, photos: JSON.parse(product.photos || '[]') }, brand, slots };
}

// Settings page "Test": runs a draft variation template on a real slot without saving anything.
export async function testVariationTemplate(slotId, content) {
  const ctx = loadCtx(slotId);
  const refs = await productRefs(ctx.product, ctx.brand);
  const text = buildPrompt('variations', content, varsFor(ctx, { variation_count: '3' }), describeRefs(refs));
  const parsed = parseJson(await ai.askClaude(text, refs.imgs, 6000));
  const list = (Array.isArray(parsed.variations) ? parsed.variations : []).filter((v) => v && v.prompt);
  if (!list.length) throw new Error('Claude returned no usable variations for this template.');
  return { variations: list, recommended: parsed.recommended ?? 0 };
}
