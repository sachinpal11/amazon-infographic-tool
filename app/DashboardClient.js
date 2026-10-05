'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDashboard } from './DashboardContext.js';
import { Avatar, Icon, STATUS, StatusDot, TYPE_LABEL } from './ui.js';
import ProductCard from './ProductCard.js';

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function headline(stats) {
  if (stats.brands === 0) return ['Start with a brand folder', 'Add a brand, then its products, and generate the infographic images for each listing.'];
  if (stats.attention > 0) {
    return [
      `${plural(stats.attention, 'image is', 'images are')} waiting for you`,
      `${stats.approved} of ${stats.slots} infographic images are approved across ${plural(stats.products, 'product', 'products')}.`,
    ];
  }
  if (stats.running > 0) {
    return ['Images are being generated', `${stats.approved} of ${stats.slots} infographic images are approved so far.`];
  }
  if (stats.slots > 0 && stats.approved === stats.slots) {
    return ['Everything is approved', `All ${plural(stats.slots, 'image', 'images')} across ${plural(stats.products, 'product', 'products')} are ready to download.`];
  }
  return ['Ready for the next listing', `${plural(stats.products, 'product', 'products')} in ${plural(stats.brands, 'brand folder', 'brand folders')}. Open one to start generating images.`];
}

function BrandFolder({ b }) {
  const pct = b.slotCount ? Math.round((b.approved / b.slotCount) * 100) : 0;
  return (
    <Link href={`/brands/${b.id}`} className="folder">
      <span className="folder-tab" />
      <div className="folder-body">
        <div className="folder-head">
          <Avatar name={b.name} logo={b.logo} />
          <div className="grow">
            <div className="folder-name">{b.name}</div>
            <div className="muted small">{plural(b.productCount, 'product', 'products')}</div>
          </div>
          <Icon name="chevron" size={16} />
        </div>
        <div className="folder-thumbs">
          {[0, 1, 2, 3].map((i) => (b.thumbs[i] ? <img key={i} src={`/api/files/${b.thumbs[i]}`} alt="" loading="lazy" /> : <span key={i} className="ph" />))}
        </div>
        <div className="meter" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="folder-foot">{b.slotCount ? `${b.approved} of ${b.slotCount} images approved` : 'No images yet'}</div>
      </div>
    </Link>
  );
}

export default function DashboardClient() {
  const { data, error, openNewBrand } = useDashboard();
  const [q, setQ] = useState('');

  if (!data) {
    return (
      <div className="page">
        {error ? <div className="banner err">{error}</div> : <div className="skeleton" />}
      </div>
    );
  }

  const { stats, brands, products, recent, attention, setup } = data;
  const [title, sub] = headline(stats);
  const needle = q.trim().toLowerCase();
  const shownBrands = brands.filter((b) => !needle || b.name.toLowerCase().includes(needle) || products.some((p) => p.brand_id === b.id && p.name.toLowerCase().includes(needle)));
  const shownProducts = needle ? products.filter((p) => p.name.toLowerCase().includes(needle) || p.brand.toLowerCase().includes(needle)) : products.slice(0, 6);
  const pct = stats.slots ? Math.round((stats.approved / stats.slots) * 100) : 0;
  const missing = [!setup.anthropic && 'ANTHROPIC_API_KEY', !setup.gemini && 'GEMINI_API_KEY'].filter(Boolean);

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>{title}</h1>
          <p>{sub}</p>
          <div className="hero-actions">
            <button className="btn btn-accent" onClick={openNewBrand}>
              <Icon name="plus" size={16} /> New brand folder
            </button>
            <Link href="/settings/templates" className="btn btn-light">
              Edit prompt templates
            </Link>
          </div>
        </div>
        <div className="sheet" aria-label="Latest approved images">
          <div className="sheet-grid">
            {Array.from({ length: 8 }, (_, i) => {
              const r = recent[i];
              return r ? (
                <Link key={i} href={`/products/${r.product_id}`} className="sheet-tile" title={r.product}>
                  <img src={`/api/files/${r.path}`} alt={`Approved image for ${r.product}`} loading="lazy" />
                </Link>
              ) : (
                <span key={i} className="sheet-tile empty" />
              );
            })}
          </div>
          <div className="sheet-cap">{recent.length ? 'Latest approved images' : 'Approved images will collect here'}</div>
        </div>
      </section>

      <section className="statband" aria-label="Summary">
        <div className="stat">
          <b>{stats.brands}</b>
          <span>Brand folders</span>
        </div>
        <div className="stat">
          <b>{stats.products}</b>
          <span>Products</span>
        </div>
        <div className="stat">
          <b>
            {stats.approved}
            <span style={{ fontSize: 16, fontWeight: 500, color: 'var(--muted)', fontFamily: 'var(--f-body)' }}> of {stats.slots}</span>
          </b>
          <span>Images approved</span>
          <div className="meter" aria-hidden="true">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="stat">
          <b>{stats.attention}</b>
          <span>{stats.running > 0 ? `Need review, ${stats.running} running now` : 'Need your review'}</span>
        </div>
      </section>

      {missing.length > 0 && (
        <div className="banner warn" style={{ marginTop: 18, marginBottom: 0 }}>
          Add {missing.join(' and ')} to <code>.env.local</code> and restart the server before generating.
        </div>
      )}
      {!setup.password && (
        <div className="banner info" style={{ marginTop: 12, marginBottom: 0 }}>
          No <code>APP_PASSWORD</code> is set, so anyone who can open this page can use the tool.
        </div>
      )}

      <div className="dash-grid">
        <div>
          <div className="sec-head">
            <h2 className="grow">Brand folders</h2>
            <div className="search">
              <Icon name="search" size={16} />
              <input type="text" placeholder="Search brands and products" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search brands and products" />
            </div>
          </div>

          {brands.length === 0 ? (
            <div className="empty">
              <h3>No brand folders yet</h3>
              <p>A brand folder holds the brand's logo, colors and tone, plus every product you make images for.</p>
              <button className="btn btn-primary" onClick={openNewBrand}>
                <Icon name="plus" size={16} /> Create the first brand
              </button>
            </div>
          ) : shownBrands.length === 0 ? (
            <div className="empty">
              <h3>No match for "{q}"</h3>
              <p>Try a different brand or product name.</p>
            </div>
          ) : (
            <div className="folders">
              {shownBrands.map((b) => (
                <BrandFolder key={b.id} b={b} />
              ))}
              {!needle && (
                <button className="folder new" onClick={openNewBrand}>
                  <span className="folder-tab" />
                  <span className="folder-body">
                    <Icon name="plus" size={22} />
                    New brand folder
                  </span>
                </button>
              )}
            </div>
          )}

          {shownProducts.length > 0 && (
            <>
              <div className="sec-head" style={{ marginTop: 38 }}>
                <h2 className="grow">{needle ? 'Matching products' : 'Recent products'}</h2>
              </div>
              <div className="pgrid">
                {shownProducts.map((p) => (
                  <ProductCard key={p.id} p={p} showBrand />
                ))}
              </div>
            </>
          )}
        </div>

        <aside>
          <section className="panel">
            <div className="panel-head">
              <h2 className="grow">Needs your attention</h2>
              {attention.length > 0 && <span className="badge warn">{stats.attention}</span>}
            </div>
            {attention.length === 0 ? (
              <p className="muted small">Nothing is waiting for you. Images that need a review or a prompt choice show up here.</p>
            ) : (
              <div>
                {attention.map((a) => (
                  <Link key={a.slot_id} href={`/products/${a.product_id}#slot-${a.slot_id}`} className="arow">
                    <StatusDot status={a.status} />
                    <div className="grow">
                      <div className="arow-title">{a.product}</div>
                      <div className="muted small">
                        Image {a.position + 1}, {(TYPE_LABEL[a.type] || a.type).toLowerCase()}
                      </div>
                    </div>
                    <span className={`badge ${STATUS[a.status][0]}`}>{STATUS[a.status][1]}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
