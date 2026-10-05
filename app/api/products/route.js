import { get, run, now, insertId } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';

const DEFAULT_SLOTS = ['features', 'benefits', 'dimensions', 'how_to_use'];

export const POST = handle(async (req) => {
  const body = await req.json();
  const name = String(body.name || '').trim();
  const brandId = Number(body.brand_id);
  if (!name) throw new HttpError(400, 'Product name is required');
  if (!get('SELECT id FROM brands WHERE id=?', brandId)) throw new HttpError(400, 'Brand not found');
  const id = insertId(
    run('INSERT INTO products (brand_id, name, created_at) VALUES (?,?,?)', brandId, name, now())
  );
  DEFAULT_SLOTS.forEach((type, i) => {
    run('INSERT INTO slots (product_id, position, type) VALUES (?,?,?)', id, i, type);
  });
  return json({ id });
});
