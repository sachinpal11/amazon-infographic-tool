import { get, run, all, deleteFile } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';

const FIELDS = ['name', 'colors', 'fonts', 'tone', 'dos', 'donts', 'notes'];

export const GET = handle(async (req, { params }) => {
  const { id } = await params;
  const brand = get('SELECT * FROM brands WHERE id=?', Number(id));
  if (!brand) throw new HttpError(404, 'Brand not found');
  return json({ brand });
});

export const PUT = handle(async (req, { params }) => {
  const { id } = await params;
  const body = await req.json();
  const sets = [];
  const vals = [];
  for (const f of FIELDS) {
    if (typeof body[f] === 'string') {
      sets.push(`${f}=?`);
      vals.push(body[f]);
    }
  }
  if (body.name !== undefined && !String(body.name).trim()) throw new HttpError(400, 'Brand name is required');
  if (sets.length) run(`UPDATE brands SET ${sets.join(', ')} WHERE id=?`, ...vals, Number(id));
  return json({ ok: true });
});

export const DELETE = handle(async (req, { params }) => {
  const { id } = await params;
  const brand = get('SELECT * FROM brands WHERE id=?', Number(id));
  if (!brand) throw new HttpError(404, 'Brand not found');
  // remove files that belong to this brand's products
  for (const p of all('SELECT * FROM products WHERE brand_id=?', brand.id)) {
    for (const f of JSON.parse(p.photos || '[]')) deleteFile(f);
    for (const i of all('SELECT i.path FROM images i JOIN slots s ON s.id=i.slot_id WHERE s.product_id=?', p.id)) deleteFile(i.path);
  }
  if (brand.logo) deleteFile(brand.logo);
  run('DELETE FROM template_versions WHERE scope=?', 'brand:' + brand.id);
  run('DELETE FROM brands WHERE id=?', brand.id);
  return json({ ok: true });
});
