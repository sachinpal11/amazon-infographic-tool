import { all } from '@/lib/db.js';
import { json, handle } from '@/lib/http.js';

export const dynamic = 'force-dynamic';

// One summary call for the sidebar, the dashboard and the brand folders.
export const GET = handle(async () => {
  const brands = all('SELECT id, name, logo FROM brands ORDER BY name COLLATE NOCASE');
  const products = all('SELECT id, brand_id, name, photos, auto_status, created_at FROM products ORDER BY created_at DESC, id DESC');
  const rows = all(
    `SELECT s.id AS slot_id, s.product_id, s.position, s.type, s.status, s.message,
       COALESCE(
         (SELECT path FROM images WHERE slot_id = s.id AND approved = 1 ORDER BY id DESC LIMIT 1),
         (SELECT path FROM images WHERE slot_id = s.id ORDER BY id DESC LIMIT 1)
       ) AS img
     FROM slots s ORDER BY s.product_id, s.position, s.id`
  );
  const recent = all(
    `SELECT i.path, p.id AS product_id, p.name AS product
     FROM images i JOIN slots s ON s.id = i.slot_id JOIN products p ON p.id = s.product_id
     WHERE i.approved = 1 ORDER BY i.id DESC LIMIT 8`
  );

  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }
  const brandName = new Map(brands.map((b) => [b.id, b.name]));

  const productList = products.map((p) => {
    const slots = byProduct.get(p.id) || [];
    const photos = JSON.parse(p.photos || '[]');
    return {
      id: p.id,
      brand_id: p.brand_id,
      brand: brandName.get(p.brand_id) || '',
      name: p.name,
      photo: photos[0] || null,
      auto_status: p.auto_status,
      slots: slots.map((s) => ({ id: s.slot_id, position: s.position, type: s.type, status: s.status })),
      total: slots.length,
      approved: slots.filter((s) => s.status === 'approved').length,
      thumbs: slots.map((s) => s.img).filter(Boolean).slice(0, 4),
    };
  });

  const brandList = brands.map((b) => {
    const mine = productList.filter((p) => p.brand_id === b.id);
    return {
      id: b.id,
      name: b.name,
      logo: b.logo,
      productCount: mine.length,
      slotCount: mine.reduce((n, p) => n + p.total, 0),
      approved: mine.reduce((n, p) => n + p.approved, 0),
      thumbs: mine.flatMap((p) => p.thumbs).slice(0, 4),
    };
  });

  const productName = new Map(productList.map((p) => [p.id, p]));
  const attention = rows
    .filter((r) => ['review', 'error', 'choose'].includes(r.status))
    .slice(0, 12)
    .map((r) => {
      const p = productName.get(r.product_id);
      return {
        slot_id: r.slot_id,
        product_id: r.product_id,
        product: p ? p.name : '',
        brand: p ? p.brand : '',
        position: r.position,
        type: r.type,
        status: r.status,
        message: r.message || '',
      };
    });

  const running =
    products.filter((p) => p.auto_status === 'running').length +
    rows.filter((r) => ['prompting', 'generating'].includes(r.status)).length;

  return json({
    setup: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      password: !!process.env.APP_PASSWORD,
    },
    stats: {
      brands: brands.length,
      products: products.length,
      slots: rows.length,
      approved: rows.filter((r) => r.status === 'approved').length,
      attention: rows.filter((r) => ['review', 'error', 'choose'].includes(r.status)).length,
      running,
    },
    brands: brandList,
    products: productList,
    recent,
    attention,
  });
});
