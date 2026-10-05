import { get, all, run, insertId, saveFile, deleteFile } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';
import { startAuto, stopAuto, restyleOthers } from '@/lib/pipeline.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_PHOTOS = 3;
const MAX_SLOTS = 6;

export const POST = handle(async (req, { params }) => {
  const { id, action } = await params;
  const pid = Number(id);
  const product = get('SELECT * FROM products WHERE id=?', pid);
  if (!product) throw new HttpError(404, 'Product not found');

  switch (action) {
    case 'photos': {
      const form = await req.formData();
      const files = form.getAll('files').filter((f) => f && typeof f !== 'string');
      const photos = JSON.parse(product.photos || '[]');
      if (!files.length) throw new HttpError(400, 'No files uploaded');
      if (photos.length + files.length > MAX_PHOTOS) {
        throw new HttpError(400, `A product can have at most ${MAX_PHOTOS} photos.`);
      }
      for (const f of files) {
        const ext = EXT[f.type];
        if (!ext) throw new HttpError(400, 'Photos must be PNG, JPG or WebP');
        photos.push(saveFile(Buffer.from(await f.arrayBuffer()), ext, 'uploads'));
      }
      run('UPDATE products SET photos=? WHERE id=?', JSON.stringify(photos), pid);
      return json({ photos });
    }
    case 'delete-photo': {
      const { path } = await req.json();
      const photos = JSON.parse(product.photos || '[]');
      if (!photos.includes(path)) throw new HttpError(404, 'Photo not found');
      const left = photos.filter((p) => p !== path);
      run('UPDATE products SET photos=? WHERE id=?', JSON.stringify(left), pid);
      deleteFile(path);
      return json({ photos: left });
    }
    case 'add-slot': {
      const body = await req.json().catch(() => ({}));
      const count = get('SELECT COUNT(*) c FROM slots WHERE product_id=?', pid).c;
      if (count >= MAX_SLOTS) throw new HttpError(400, `At most ${MAX_SLOTS} images per product.`);
      const pos = (get('SELECT MAX(position) m FROM slots WHERE product_id=?', pid).m ?? -1) + 1;
      const slotId = insertId(
        run('INSERT INTO slots (product_id, position, type, brief) VALUES (?,?,?,?)', pid, pos, body.type || 'other', body.brief || '')
      );
      return json({ id: slotId });
    }
    case 'auto-start': {
      const body = await req.json();
      startAuto(pid, body.mode, body.anchorSlotId);
      return json({ ok: true });
    }
    case 'auto-stop': {
      stopAuto(pid);
      return json({ ok: true });
    }
    case 'restyle': {
      restyleOthers(pid);
      return json({ ok: true });
    }
    case 'reset-auto': {
      if (product.auto_status === 'running') throw new HttpError(409, 'Stop auto mode first.');
      run("UPDATE products SET auto_status='idle', auto_message='', auto_mode='off' WHERE id=?", pid);
      return json({ ok: true });
    }
    default:
      throw new HttpError(404, 'Unknown action');
  }
});
