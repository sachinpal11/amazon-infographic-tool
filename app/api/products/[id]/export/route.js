import JSZip from 'jszip';
import { get, all, readFile } from '@/lib/db.js';
import { HttpError, handle } from '@/lib/http.js';

export const dynamic = 'force-dynamic';

const clean = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'item';

export const GET = handle(async (req, { params }) => {
  const { id } = await params;
  const product = get('SELECT * FROM products WHERE id=?', Number(id));
  if (!product) throw new HttpError(404, 'Product not found');
  const brand = get('SELECT * FROM brands WHERE id=?', product.brand_id);
  const slots = all('SELECT * FROM slots WHERE product_id=? ORDER BY position, id', product.id);

  const zip = new JSZip();
  const notes = [];
  let n = 0;
  for (const s of slots) {
    // approved image if there is one, otherwise the newest
    const img =
      get('SELECT * FROM images WHERE slot_id=? AND approved=1 ORDER BY id DESC LIMIT 1', s.id) ||
      get('SELECT * FROM images WHERE slot_id=? ORDER BY id DESC LIMIT 1', s.id);
    if (!img) continue;
    n += 1;
    const ext = img.path.split('.').pop();
    const name = `${clean(brand.name)}_${clean(product.name)}_${String(n).padStart(2, '0')}_${clean(s.type)}.${ext}`;
    zip.file(name, readFile(img.path));
    const prompt = img.prompt_id ? get('SELECT text FROM prompts WHERE id=?', img.prompt_id) : null;
    notes.push(`${name}${img.approved ? '' : '  (not approved)'}\n${prompt ? prompt.text : ''}\n`);
  }
  if (!n) throw new HttpError(400, 'There are no generated images to export yet.');
  zip.file('prompts.txt', notes.join('\n----\n\n'));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return new Response(buf, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${clean(brand.name)}_${clean(product.name)}.zip"`,
    },
  });
});
