'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../../api-client.js';
import { useDashboard } from '../../DashboardContext.js';
import { Avatar, Crumbs, Icon, NameModal } from '../../ui.js';
import ProductCard from '../../ProductCard.js';

const SECTIONS = [
  {
    title: 'Look',
    hint: 'What the designer should use on every image.',
    fields: [
      ['colors', 'Colors', 'e.g. Primary navy #0B1F4B, accent orange #FF8A00, white backgrounds', 2],
      ['fonts', 'Fonts', 'e.g. Montserrat Bold for headlines, Open Sans for body text', 2],
    ],
  },
  {
    title: 'Voice and rules',
    hint: 'How the text sounds, and what to always or never do.',
    fields: [
      ['tone', 'Tone of voice', 'e.g. Confident, simple, friendly. Short punchy headlines.', 2],
      ['dos', 'Always do', 'e.g. Use flat icons. Keep lots of white space. Show the logo bottom-right.', 3],
      ['donts', 'Never do', 'e.g. No stock-photo people. No red. Never use the word "cheap".', 3],
      ['notes', 'Other notes', 'Anything else the designer should know about this brand', 3],
    ],
  },
];
const FIELD_KEYS = SECTIONS.flatMap((s) => s.fields.map((f) => f[0]));

export default function BrandClient({ id }) {
  const router = useRouter();
  const { data, refresh } = useDashboard();
  const [brand, setBrand] = useState(null);
  const [tab, setTab] = useState('products');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [productModal, setProductModal] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { brand } = await api(`/api/brands/${id}`);
        setBrand(brand);
      } catch (e) {
        setError(e.message);
      }
    })();
  }, [id]);

  function set(field, value) {
    setSaved(false);
    setBrand((b) => ({ ...b, [field]: value }));
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const body = { name: brand.name || '' };
      for (const f of FIELD_KEYS) body[f] = brand[f] || '';
      await api(`/api/brands/${id}`, { method: 'PUT', body });
      setSaved(true);
      refresh();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  async function uploadLogo(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const { logo } = await api(`/api/brands/${id}/logo`, { method: 'POST', body: form });
      setBrand((b) => ({ ...b, logo }));
      refresh();
    } catch (err) {
      setError(err.message);
    }
    e.target.value = '';
  }

  async function removeLogo() {
    await api(`/api/brands/${id}/logo`, { method: 'DELETE' });
    setBrand((b) => ({ ...b, logo: null }));
    refresh();
  }

  async function remove() {
    if (!window.confirm('Delete this brand with all its products, images and prompt overrides? This cannot be undone.')) return;
    try {
      await api(`/api/brands/${id}`, { method: 'DELETE' });
      await refresh();
      router.push('/');
    } catch (e) {
      setError(e.message);
    }
  }

  if (!brand) {
    return <div className="page">{error ? <div className="banner err">{error}</div> : <div className="skeleton" />}</div>;
  }

  const products = (data?.products || []).filter((p) => p.brand_id === id);
  const approved = products.reduce((n, p) => n + p.approved, 0);
  const total = products.reduce((n, p) => n + p.total, 0);

  return (
    <div className="page">
      <Crumbs items={[{ href: '/', label: 'Dashboard' }, { label: brand.name }]} />
      <header className="page-head">
        <Avatar name={brand.name} logo={brand.logo} large />
        <div className="grow">
          <h1>{brand.name}</h1>
          <p className="muted">
            {products.length} {products.length === 1 ? 'product' : 'products'}, {approved} of {total} images approved
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setProductModal(true)}>
          <Icon name="plus" size={16} /> New product
        </button>
      </header>

      {error && <div className="banner err">{error}</div>}

      <div className="seg" role="tablist" aria-label="Brand sections">
        <button role="tab" aria-selected={tab === 'products'} className={tab === 'products' ? 'on' : ''} onClick={() => setTab('products')}>
          Products
        </button>
        <button role="tab" aria-selected={tab === 'profile'} className={tab === 'profile' ? 'on' : ''} onClick={() => setTab('profile')}>
          Brand profile
        </button>
      </div>

      {tab === 'products' && (
        <>
          {products.length === 0 ? (
            <div className="empty">
              <h3>This folder has no products yet</h3>
              <p>Add a product, upload its real photos, and write a short brief for each infographic image.</p>
              <button className="btn btn-primary" onClick={() => setProductModal(true)}>
                <Icon name="plus" size={16} /> Create the first product
              </button>
            </div>
          ) : (
            <div className="pgrid">
              {products.map((p) => (
                <ProductCard key={p.id} p={p} />
              ))}
              <button className="pcard new" onClick={() => setProductModal(true)}>
                <Icon name="plus" size={22} />
                New product
              </button>
            </div>
          )}
          {!brand.colors && !brand.tone && (
            <div className="banner info" style={{ marginTop: 22 }}>
              This brand profile is empty. Colors, fonts and tone make the generated prompts much more on-brand.{' '}
              <button className="btn btn-quiet btn-sm" onClick={() => setTab('profile')}>
                Fill in the profile
              </button>
            </div>
          )}
        </>
      )}

      {tab === 'profile' && (
        <div className="stack" style={{ maxWidth: 820 }}>
          <section className="panel stack">
            <div>
              <h2>Identity</h2>
              <p className="muted small" style={{ marginTop: 3 }}>The logo is sent to the image model as a reference, so it is reproduced exactly.</p>
            </div>
            <div>
              <label className="field" htmlFor="brand-name">Brand name</label>
              <input id="brand-name" type="text" value={brand.name || ''} onChange={(e) => set('name', e.target.value)} />
            </div>
            <div>
              <label className="field">Logo (PNG, JPG or WebP)</label>
              <div className="row">
                {brand.logo && (
                  <div className="photo">
                    <img src={`/api/files/${brand.logo}`} alt="Brand logo" />
                  </div>
                )}
                <label className="btn btn-quiet btn-sm filebtn">
                  {brand.logo ? 'Replace logo' : 'Upload logo'}
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadLogo} />
                </label>
                {brand.logo && (
                  <button className="btn btn-danger btn-sm" onClick={removeLogo}>
                    Remove logo
                  </button>
                )}
              </div>
            </div>
          </section>

          {SECTIONS.map((sec) => (
            <section className="panel stack" key={sec.title}>
              <div>
                <h2>{sec.title}</h2>
                <p className="muted small" style={{ marginTop: 3 }}>{sec.hint}</p>
              </div>
              {sec.fields.map(([key, label, placeholder, rows]) => (
                <div key={key}>
                  <label className="field" htmlFor={`f-${key}`}>{label}</label>
                  <textarea id={`f-${key}`} rows={rows} placeholder={placeholder} value={brand[key] || ''} onChange={(e) => set(key, e.target.value)} />
                </div>
              ))}
            </section>
          ))}

          <div className="row">
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? 'Saving...' : 'Save brand'}
            </button>
            {saved && <span className="badge ok">Saved</span>}
            <div className="grow" />
            <Link href={`/settings/templates?scope=brand:${id}`} className="btn btn-quiet btn-sm">
              Customize prompt templates for this brand
            </Link>
            <button className="btn btn-danger btn-sm" onClick={remove}>
              Delete brand
            </button>
          </div>
        </div>
      )}

      {productModal && (
        <NameModal
          title="New product"
          label="Product name"
          placeholder="e.g. Steel Water Bottle 750 ml"
          cta="Create product"
          onClose={() => setProductModal(false)}
          onSubmit={async (name) => {
            const { id: pid } = await api('/api/products', { method: 'POST', body: { name, brand_id: id } });
            await refresh();
            setProductModal(false);
            router.push(`/products/${pid}`);
          }}
        />
      )}
    </div>
  );
}
