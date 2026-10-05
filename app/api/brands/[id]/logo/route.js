import { get, run, saveFile, deleteFile } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export const POST = handle(async (req, { params }) => {
  const { id } = await params;
  const brand = get('SELECT * FROM brands WHERE id=?', Number(id));
  if (!brand) throw new HttpError(404, 'Brand not found');
  const form = await req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'No file uploaded');
  const ext = EXT[file.type];
  if (!ext) throw new HttpError(400, 'Logo must be a PNG, JPG or WebP image');
  const rel = saveFile(Buffer.from(await file.arrayBuffer()), ext, 'logos');
  if (brand.logo) deleteFile(brand.logo);
  run('UPDATE brands SET logo=? WHERE id=?', rel, brand.id);
  return json({ logo: rel });
});

export const DELETE = handle(async (req, { params }) => {
  const { id } = await params;
  const brand = get('SELECT * FROM brands WHERE id=?', Number(id));
  if (!brand) throw new HttpError(404, 'Brand not found');
  if (brand.logo) deleteFile(brand.logo);
  run('UPDATE brands SET logo=NULL WHERE id=?', brand.id);
  return json({ ok: true });
});
