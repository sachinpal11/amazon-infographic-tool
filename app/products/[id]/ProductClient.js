'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../api-client.js';
import { useDashboard } from '../../DashboardContext.js';
import { Crumbs, Icon, STATUS, StatusDot, TYPE_LABEL, TYPE_OPTIONS } from '../../ui.js';

const BUSY = ['prompting', 'generating'];

export default function ProductClient({ id }) {
  const router = useRouter();
  const { refresh: refreshDash } = useDashboard();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/products/${id}`));
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const autoRunning = data?.product.auto_status === 'running';
  const busy = !!data && (autoRunning || data.slots.some((s) => BUSY.includes(s.status)));
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [busy, load]);

  if (!data) {
    return <div className="page">{error ? <div className="banner err">{error}</div> : <div className="skeleton" />}</div>;
  }
  const { product, brand, slots } = data;
  const approved = slots.filter((s) => s.status === 'approved').length;
  const hasImages = slots.some((s) => s.images.length > 0);

  async function addSlot() {
    setError('');
    try {
      await api(`/api/products/${id}/add-slot`, { method: 'POST', body: { type: 'other' } });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeProduct() {
    if (!window.confirm('Delete this product with all its images? This cannot be undone.')) return;
    try {
      await api(`/api/products/${id}`, { method: 'DELETE' });
      await refreshDash();
      router.push(`/brands/${brand.id}`);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="page">
      <Crumbs items={[{ href: '/', label: 'Dashboard' }, { href: `/brands/${brand.id}`, label: brand.name }, { label: product.name }]} />

      <header className="page-head">
        <div className="thumb-lg">{product.photos[0] ? <img src={`/api/files/${product.photos[0]}`} alt="" /> : <Icon name="image" size={26} />}</div>
        <div className="grow">
          <h1>{product.name}</h1>
          <p className="muted">
            {approved} of {slots.length} images approved
          </p>
        </div>
        {hasImages && (
          <a className="btn btn-quiet" href={`/api/products/${id}/export`}>
            <Icon name="download" size={16} /> Download all (zip)
          </a>
        )}
        <button className="btn btn-danger" onClick={removeProduct}>
          Delete product
        </button>
      </header>

      {error && (
        <div className="banner err row">
          <span className="grow">{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}

      <nav className="strip" aria-label="Images in this product">
        {slots.map((s, i) => {
          const img = s.images.find((x) => x.approved) || s.images[0];
          return (
            <a key={s.id} href={`#slot-${s.id}`} className="tile">
              <div className="tile-img">{img ? <img src={`/api/files/${img.path}`} alt="" /> : i + 1}</div>
              <div className="tile-cap">
                <StatusDot status={s.status} />
                {(STATUS[s.status] || ['', s.status])[1]}
              </div>
            </a>
          );
        })}
      </nav>

      <div className="workspace">
        <div className="ws-main">
          {slots.map((s, i) => (
            <SlotCard key={s.id} slot={s} index={i} locked={autoRunning} reload={load} onError={setError} />
          ))}
          <button className="btn btn-quiet" onClick={addSlot} disabled={autoRunning}>
            <Icon name="plus" size={16} /> Add another image
          </button>
        </div>

        <aside className="ws-side">
          <ProductPanel product={product} reload={load} onError={setError} />
          <AutoPanel product={product} slots={slots} reload={load} onError={setError} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function ProductPanel({ product, reload, onError }) {
  const [name, setName] = useState(product.name);
  const [details, setDetails] = useState(product.details || '');
  const [retries, setRetries] = useState(product.max_retries ?? 2);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    onError('');
    try {
      await api(`/api/products/${product.id}`, { method: 'PUT', body: { name, details, max_retries: Number(retries) } });
      setSaved(true);
      await reload();
    } catch (e) {
      onError(e.message);
    }
    setBusy(false);
  }

  async function upload(e) {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    onError('');
    try {
      const form = new FormData();
      files.forEach((f) => form.append('files', f));
      await api(`/api/products/${product.id}/photos`, { method: 'POST', body: form });
      await reload();
    } catch (err) {
      onError(err.message);
    }
    e.target.value = '';
  }

  async function removePhoto(path) {
    try {
      await api(`/api/products/${product.id}/delete-photo`, { method: 'POST', body: { path } });
      await reload();
    } catch (e) {
      onError(e.message);
    }
  }

  const touch = (fn) => (e) => {
    fn(e.target.value);
    setSaved(false);
  };

  return (
    <section className="panel stack">
      <h2>Product</h2>
      <div>
        <label className="field" htmlFor="p-name">Product name</label>
        <input id="p-name" type="text" value={name} onChange={touch(setName)} />
      </div>
      <div>
        <label className="field" htmlFor="p-details">Product details (materials, sizes, what is included, key facts)</label>
        <textarea
          id="p-details"
          rows={3}
          value={details}
          placeholder="e.g. 750 ml double-wall vacuum insulated steel bottle, keeps cold 24 h and hot 12 h, BPA free, 7.5 cm x 26 cm"
          onChange={touch(setDetails)}
        />
      </div>
      <div>
        <label className="field">Real product photos (1 to 3, required)</label>
        <p className="muted small" style={{ marginBottom: 8 }}>The image model uses these to draw your actual product.</p>
        <div className="photos">
          {product.photos.map((p) => (
            <div className="photo" key={p}>
              <img src={`/api/files/${p}`} alt="Product" />
              <button title="Remove photo" aria-label="Remove photo" onClick={() => removePhoto(p)}>
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          {product.photos.length < 3 && (
            <label className="photo filebtn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', color: 'var(--muted)' }} title="Add photos">
              <Icon name="plus" size={22} />
              <input type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={upload} />
            </label>
          )}
        </div>
        {product.photos.length === 0 && (
          <div className="small" style={{ color: 'var(--warn)', marginTop: 8 }}>Upload at least one photo before generating anything.</div>
        )}
      </div>
      <div>
        <label className="field" htmlFor="p-retries">Auto-mode retries (0 to 5)</label>
        <input id="p-retries" type="number" min="0" max="5" value={retries} onChange={touch(setRetries)} style={{ width: 110 }} />
      </div>
      <div className="row">
        <button className="btn btn-primary" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Saving...' : 'Save product'}
        </button>
        {saved && <span className="badge ok">Saved</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
function AutoPanel({ product, slots, reload, onError }) {
  const [mode, setMode] = useState(product.auto_mode === 'finetune' ? 'finetune' : 'full');
  const [anchor, setAnchor] = useState(product.anchor_slot_id || slots[0]?.id || '');
  const [spec, setSpec] = useState(product.style_spec || '');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) setSpec(product.style_spec || '');
  }, [product.style_spec, dirty]);

  const status = product.auto_status;
  const anchorSlot = slots.find((s) => s.id === product.anchor_slot_id);

  async function call(path, body) {
    setBusy(true);
    onError('');
    try {
      await api(`/api/products/${product.id}/${path}`, { method: 'POST', body: body || {} });
      await reload();
    } catch (e) {
      onError(e.message);
    }
    setBusy(false);
  }

  async function saveSpec() {
    try {
      await api(`/api/products/${product.id}`, { method: 'PUT', body: { style_spec: spec } });
      setDirty(false);
      await reload();
    } catch (e) {
      onError(e.message);
    }
  }

  return (
    <section className="panel stack">
      <h2>Auto mode</h2>

      {status === 'running' && (
        <div className="banner info row" style={{ marginBottom: 0 }}>
          <span className="grow">
            <span className="spinner" />
            {product.auto_message || 'Auto mode is running...'}
          </span>
          <button className="btn btn-danger btn-sm" onClick={() => call('auto-stop')} disabled={busy}>
            Stop
          </button>
        </div>
      )}

      {status === 'awaiting_anchor' && (
        <div className="banner warn" style={{ marginBottom: 0 }}>
          <div>{product.auto_message}</div>
          <button className="btn btn-quiet btn-sm" style={{ marginTop: 10 }} onClick={() => call('auto-stop')} disabled={busy}>
            Cancel fine-tune
          </button>
        </div>
      )}

      {(status === 'done' || status === 'stopped') && product.auto_message && (
        <div className={`banner ${status === 'done' ? 'ok' : 'warn'}`} style={{ marginBottom: 0 }}>
          {product.auto_message}
        </div>
      )}

      {status !== 'running' && status !== 'awaiting_anchor' && (
        <>
          <p className="muted small">
            Works on this product only. It writes the prompts, generates each image, checks quality and retries up to the limit above.
          </p>
          <label className={`choice ${mode === 'full' ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={mode === 'full'} onChange={() => setMode('full')} />
            <span>
              <b>Full auto</b>
              <small>All images run on their own, no questions asked.</small>
            </span>
          </label>
          <label className={`choice ${mode === 'finetune' ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={mode === 'finetune'} onChange={() => setMode('finetune')} />
            <span>
              <b>Auto with fine-tune</b>
              <small>You shape one anchor image by hand. The others copy its style.</small>
            </span>
          </label>
          {mode === 'finetune' && (
            <div>
              <label className="field" htmlFor="anchor">Style anchor image</label>
              <select id="anchor" value={anchor} onChange={(e) => setAnchor(Number(e.target.value))}>
                {slots.map((s, i) => (
                  <option key={s.id} value={s.id}>
                    Image {i + 1} ({TYPE_LABEL[s.type] || s.type})
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            className="btn btn-accent"
            style={{ width: '100%' }}
            onClick={() => call('auto-start', { mode, anchorSlotId: mode === 'finetune' ? Number(anchor) : undefined })}
            disabled={busy || !slots.length}
          >
            {mode === 'full' ? 'Start full auto' : 'Start fine-tune'}
          </button>
        </>
      )}

      {(product.style_spec || spec) && (
        <div>
          <label className="field" htmlFor="style-spec">
            Locked style{anchorSlot ? ` (from image ${slots.indexOf(anchorSlot) + 1})` : ''}
          </label>
          <p className="muted small" style={{ marginBottom: 8 }}>Added to every prompt in auto mode. You can edit it.</p>
          <textarea
            id="style-spec"
            rows={5}
            value={spec}
            onChange={(e) => {
              setSpec(e.target.value);
              setDirty(true);
            }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-quiet btn-sm" onClick={saveSpec} disabled={!dirty}>
              Save style
            </button>
            {product.auto_mode === 'finetune' && anchorSlot?.status === 'approved' && status !== 'running' && (
              <button
                className="btn btn-quiet btn-sm"
                onClick={() => {
                  if (window.confirm('Regenerate all the other images in the style of the current anchor image? Existing images are kept in their history.')) call('restyle');
                }}
                disabled={busy}
              >
                Re-run the other images in this style
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
function QC({ qc }) {
  if (!qc) return <div className="qc muted small">No quality check result for this image.</div>;
  if (qc.error) {
    return (
      <div className="qc">
        <span className="badge warn">Quality check unavailable</span> <span className="small muted">{qc.error}</span>
      </div>
    );
  }
  return (
    <div className="qc">
      <span className={`badge ${qc.pass ? 'ok' : 'err'}`}>{qc.pass ? 'Quality check passed' : 'Quality check found problems'}</span>{' '}
      {qc.summary && <span className="small muted">{qc.summary}</span>}
      {qc.issues && qc.issues.length > 0 && (
        <ul>
          {qc.issues.map((i, k) => (
            <li key={k} className={i.severity}>
              <b>{String(i.category).replace('_', ' ')}:</b> {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SlotCard({ slot, index, locked, reload, onError }) {
  const [brief, setBrief] = useState(slot.brief || '');
  const [note, setNote] = useState('');
  const [edits, setEdits] = useState({});
  const [viewId, setViewId] = useState(null);
  const [acting, setActing] = useState(false);

  const working = BUSY.includes(slot.status);
  const disabled = working || locked || acting;
  const [badgeCls, badgeLabel] = STATUS[slot.status] || ['', slot.status];

  async function act(action, body = {}) {
    setActing(true);
    onError('');
    try {
      await api(`/api/slots/${slot.id}/${action}`, { method: 'POST', body });
      if (['choose', 'generate', 'redo'].includes(action)) setViewId(null);
      await reload();
    } catch (e) {
      onError(e.message);
    }
    setActing(false);
  }

  async function saveSlot(patch) {
    try {
      await api(`/api/slots/${slot.id}`, { method: 'PUT', body: patch });
    } catch (e) {
      onError(e.message);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete image ${index + 1} and everything generated for it?`)) return;
    try {
      await api(`/api/slots/${slot.id}`, { method: 'DELETE' });
      await reload();
    } catch (e) {
      onError(e.message);
    }
  }

  const variations = slot.prompts.filter((p) => p.source === 'variation');
  const batch = variations.length ? variations[0].batch : null;
  const batchPrompts = variations.filter((p) => p.batch === batch).sort((a, b) => a.id - b.id);
  const img = slot.images.find((i) => i.id === viewId) || slot.images[0];
  const imgPrompt = img ? slot.prompts.find((p) => p.id === img.prompt_id) : null;
  const isCurrentPrompt = imgPrompt && imgPrompt.id === slot.selected_prompt_id;

  return (
    <section className="slot" id={`slot-${slot.id}`}>
      <div className="slot-top">
        <div className="slot-num">{index + 1}</div>
        <select className="select-sm" defaultValue={slot.type} disabled={disabled} onChange={(e) => saveSlot({ type: e.target.value })} aria-label={`Type of image ${index + 1}`}>
          {TYPE_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <span className={`badge ${badgeCls}`}>{badgeLabel}</span>
        <div className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={remove} disabled={disabled}>
          Delete
        </button>
      </div>

      <div className="slot-body">
        <div className="slot-visual">
          <div className={`frame ${working ? 'loading' : ''}`}>
            {img ? (
              <img className="generated" src={`/api/files/${img.path}`} alt={`Generated image ${index + 1}`} />
            ) : (
              !working && (
                <div className="frame-empty">
                  <Icon name="image" size={30} />
                  <span>Your image appears here</span>
                </div>
              )
            )}
          </div>
          {slot.images.length > 1 && (
            <div className="thumbs">
              {slot.images.map((i) => (
                <img
                  key={i.id}
                  src={`/api/files/${i.path}`}
                  alt="Earlier version"
                  className={`${i.id === img.id ? 'sel' : ''} ${i.approved ? 'appr' : ''}`}
                  onClick={() => setViewId(i.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="side stack">
          <div>
            <label className="field" htmlFor={`brief-${slot.id}`}>What should this image show?</label>
            <textarea
              id={`brief-${slot.id}`}
              rows={3}
              value={brief}
              placeholder="e.g. Show the bottle with callouts for: 24h cold / 12h hot, leak-proof lid, fits car cup holders, BPA free"
              onChange={(e) => setBrief(e.target.value)}
              onBlur={() => brief !== (slot.brief || '') && saveSlot({ brief })}
              disabled={working}
            />
          </div>

          {working && (
            <div className="banner info" style={{ marginBottom: 0 }}>
              <span className="spinner" />
              {slot.message || 'Working...'}
            </div>
          )}
          {slot.status === 'error' && (
            <div className="banner err" style={{ marginBottom: 0 }}>
              {slot.message || 'Something went wrong.'}
            </div>
          )}
          {slot.status === 'review' && slot.message && (
            <div className="banner warn" style={{ marginBottom: 0 }}>
              {slot.message}
            </div>
          )}

          <div className="row">
            <button
              className={`btn ${slot.images.length ? 'btn-quiet' : 'btn-primary'}`}
              onClick={async () => {
                if (brief !== (slot.brief || '')) await saveSlot({ brief });
                act('variations');
              }}
              disabled={disabled || !brief.trim()}
            >
              {variations.length ? 'Write new prompt variations' : 'Write 3 prompt variations'}
            </button>
          </div>

          {img && (
            <>
              <div className="row">
                {img.approved ? (
                  <span className="badge ok">
                    <Icon name="check" size={14} /> Approved
                  </span>
                ) : (
                  <button className="btn btn-primary" onClick={() => act('approve', { imageId: img.id })} disabled={disabled}>
                    Approve this image
                  </button>
                )}
                <a className="btn btn-quiet" href={`/api/files/${img.path}`} download>
                  <Icon name="download" size={16} /> Download
                </a>
              </div>

              <QC qc={img.qc} />

              <div className="redo">
                <h3>Not happy? Redo with a new prompt</h3>
                <p className="muted small" style={{ margin: '4px 0 10px' }}>
                  Claude looks at this image, writes one new prompt using your note, then generates again. Leave the note empty for a fresh take.
                </p>
                <input type="text" value={note} placeholder="e.g. product too small, text too crowded" onChange={(e) => setNote(e.target.value)} disabled={disabled} />
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      await act('redo', { note });
                      setNote('');
                    }}
                    disabled={disabled}
                  >
                    Redo
                  </button>
                  <button className="btn btn-quiet btn-sm" onClick={() => act('generate')} disabled={disabled || !slot.selected_prompt_id}>
                    Regenerate with the same prompt
                  </button>
                </div>
              </div>

              {imgPrompt && (
                <details className="prompt-details">
                  <summary>Prompt used for this image{imgPrompt.source === 'redo' ? ' (written by Claude after a redo)' : ''}</summary>
                  {isCurrentPrompt ? (
                    <div style={{ marginTop: 10 }}>
                      <textarea
                        className="mono"
                        rows={9}
                        value={edits[imgPrompt.id] ?? imgPrompt.text}
                        onChange={(e) => setEdits({ ...edits, [imgPrompt.id]: e.target.value })}
                        disabled={disabled}
                      />
                      <button
                        className="btn btn-quiet btn-sm"
                        style={{ marginTop: 8 }}
                        onClick={() => act('choose', { promptId: imgPrompt.id, text: edits[imgPrompt.id] ?? imgPrompt.text })}
                        disabled={disabled}
                      >
                        Generate with this edited prompt
                      </button>
                    </div>
                  ) : (
                    <pre className="mono locked" style={{ marginTop: 10 }}>{imgPrompt.text}</pre>
                  )}
                  {imgPrompt.template_version && <div className="small muted" style={{ marginTop: 6 }}>Template version: {imgPrompt.template_version}</div>}
                </details>
              )}
            </>
          )}
        </div>

        {slot.status === 'choose' && batchPrompts.length > 0 && (
          <div className="slot-variations">
            <h3>Choose a prompt</h3>
            <p className="muted small" style={{ marginTop: 3 }}>You can edit any prompt before generating.</p>
            <div className="variations">
              {batchPrompts.map((p) => (
                <div key={p.id} className={`variation ${p.recommended ? 'rec' : ''}`}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <b>{p.label}</b>
                    {p.recommended ? <span className="badge warn">Claude recommends</span> : null}
                  </div>
                  <textarea className="mono" value={edits[p.id] ?? p.text} onChange={(e) => setEdits({ ...edits, [p.id]: e.target.value })} disabled={disabled} />
                  <button className="btn btn-primary" style={{ marginTop: 10, width: '100%' }} onClick={() => act('choose', { promptId: p.id, text: edits[p.id] ?? p.text })} disabled={disabled}>
                    Use this and generate image
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
