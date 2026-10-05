import { get, run, all, deleteFile } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';

export const PUT = handle(async (req, { params }) => {
  const { id } = await params;
  const slot = get('SELECT * FROM slots WHERE id=?', Number(id));
  if (!slot) throw new HttpError(404, 'Slot not found');
  const body = await req.json();
  if (typeof body.brief === 'string') run('UPDATE slots SET brief=? WHERE id=?', body.brief, slot.id);
  if (typeof body.type === 'string') run('UPDATE slots SET type=? WHERE id=?', body.type, slot.id);
  return json({ ok: true });
});

export const DELETE = handle(async (req, { params }) => {
  const { id } = await params;
  const slot = get('SELECT * FROM slots WHERE id=?', Number(id));
  if (!slot) throw new HttpError(404, 'Slot not found');
  if (['prompting', 'generating'].includes(slot.status)) throw new HttpError(409, 'This image is being worked on.');
  for (const i of all('SELECT path FROM images WHERE slot_id=?', slot.id)) deleteFile(i.path);
  run('DELETE FROM slots WHERE id=?', slot.id);
  return json({ ok: true });
});
