import { all, run, now, insertId } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';

export const GET = handle(async () => {
  return json({ brands: all('SELECT * FROM brands ORDER BY name') });
});

export const POST = handle(async (req) => {
  const body = await req.json();
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'Brand name is required');
  const id = insertId(run('INSERT INTO brands (name, created_at) VALUES (?, ?)', name, now()));
  return json({ id });
});
