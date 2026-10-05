import { get, all, run, deleteFile } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';
import { getProductTree } from '@/lib/pipeline.js';

export const dynamic = 'force-dynamic';

export const GET = handle(async (req, { params }) => {
  const { id } = await params;
  const tree = getProductTree(Number(id));
  if (!tree) throw new HttpError(404, 'Product not found');
  return json(tree);
});

export const PUT = handle(async (req, { params }) => {
  const { id } = await params;
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
    const n = Math.max(0, Math.min(5, Number(body.max_retries) || 0));
    sets.push('max_retries=?');
    vals.push(n);
  }
  if (typeof body.style_spec === 'string') {
    sets.push('style_spec=?');
    vals.push(body.style_spec);
  }
  if (sets.length) run(`UPDATE products SET ${sets.join(', ')} WHERE id=?`, ...vals, Number(id));
  return json({ ok: true });
});

export const DELETE = handle(async (req, { params }) => {
  const { id } = await params;
  const p = get('SELECT * FROM products WHERE id=?', Number(id));
  if (!p) throw new HttpError(404, 'Product not found');
  if (p.auto_status === 'running') throw new HttpError(409, 'Stop auto mode first.');
  for (const f of JSON.parse(p.photos || '[]')) deleteFile(f);
  for (const i of all('SELECT i.path FROM images i JOIN slots s ON s.id=i.slot_id WHERE s.product_id=?', p.id)) deleteFile(i.path);
  run('DELETE FROM products WHERE id=?', p.id);
  return json({ ok: true });
});
