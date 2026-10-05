'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api-client.js';
import { Crumbs } from '../../ui.js';

const KEYS = ['variations', 'redo', 'style_spec', 'qc'];
const SHORT = { variations: 'Variations', redo: 'Redo', style_spec: 'Style spec', qc: 'Quality check' };

export default function TemplatesClient({ initialScope }) {
  const [scope, setScope] = useState(initialScope || 'global');
  const [data, setData] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [active, setActive] = useState('variations');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [testSlot, setTestSlot] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const ta = useRef(null);

  const load = useCallback(async (sc) => {
    setError('');
    try {
      const d = await api(`/api/templates?scope=${encodeURIComponent(sc)}`);
      setData(d);
      const next = {};
      for (const k of KEYS) next[k] = d.templates[k].content;
      setDrafts(next);
      setTestResult(null);
      setTestSlot((cur) => cur || (d.testTargets[0] ? String(d.testTargets[0].id) : ''));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load(scope);
  }, [scope, load]);

  if (!data) {
    return <div className="page">{error ? <div className="banner err">{error}</div> : <div className="skeleton" />}</div>;
  }

  const t = data.templates[active];
  const draft = drafts[active] ?? '';
  const dirty = draft !== t.content;
  const known = new Set(data.placeholders.map((p) => p.name));
  const unknown = [...new Set([...draft.matchAll(/\{\{\s*([A-Za-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((n) => !known.has(n)))];
  const isBrand = scope !== 'global';

  function sourceText() {
    if (t.source === 'brand') return `this brand's own override (${t.version})`;
    if (t.source === 'global') return `your global edit (${t.version})`;
    return 'the built-in default';
  }

  function insertPlaceholder(name) {
    const el = ta.current;
    const tag = `{{${name}}}`;
    if (!el) {
      setDrafts({ ...drafts, [active]: draft + tag });
      return;
    }
    const a = el.selectionStart;
    const b = el.selectionEnd;
    setDrafts({ ...drafts, [active]: draft.slice(0, a) + tag + draft.slice(b) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + tag.length, a + tag.length);
    });
  }

  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api('/api/templates', { method: 'PUT', body: { scope, key: active, content: draft } });
      setNotice(`Saved as version ${r.version}.`);
      await load(scope);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  async function reset() {
    const msg = isBrand ? "Remove this brand's override so it uses the global template again?" : 'Reset this template to the built-in default? The current text stays in the version history.';
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/templates', { method: 'POST', body: { action: 'reset', scope, key: active } });
      setNotice(isBrand ? 'Override removed.' : 'Reset to the built-in default.');
      await load(scope);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  async function runTest() {
    setTesting(true);
    setError('');
    setTestResult(null);
    try {
      setTestResult(await api('/api/templates', { method: 'POST', body: { action: 'test', slotId: Number(testSlot), content: draft } }));
    } catch (e) {
      setError(e.message);
    }
    setTesting(false);
  }

  return (
    <div className="page">
      <Crumbs items={[{ href: '/', label: 'Dashboard' }, { label: 'Prompt templates' }]} />
      <header className="page-head">
        <div className="grow">
          <h1>Prompt templates</h1>
          <p className="muted" style={{ maxWidth: '62ch' }}>
            These are the instructions Claude follows when it writes image prompts. Every prompt records which template version produced it.
          </p>
        </div>
        <div style={{ width: 280 }}>
          <label className="field" htmlFor="scope">Applies to</label>
          <select id="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="global">Global (all brands)</option>
            {data.brands.map((b) => (
              <option key={b.id} value={`brand:${b.id}`}>
                Brand override: {b.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      <p className="muted small" style={{ marginBottom: 18 }}>
        {isBrand ? 'A brand override replaces the global template for this brand only. Brands without an override use the global one.' : 'Used by every brand that has no override of its own.'}
      </p>

      <div className="tpl">
        <div className="rail" role="tablist" aria-label="Templates">
          {KEYS.map((k) => (
            <button key={k} role="tab" aria-selected={k === active} className={k === active ? 'on' : ''} onClick={() => setActive(k)}>
              {SHORT[k]}
              {drafts[k] !== data.templates[k].content ? ' *' : ''}
            </button>
          ))}
        </div>

        <div className="stack">
          <section className="panel stack">
            <div>
              <h2>{t.title}</h2>
              <p className="muted small" style={{ marginTop: 3 }}>{t.description}</p>
              <p className="small" style={{ marginTop: 6 }}>
                Currently using: <b>{sourceText()}</b>
              </p>
            </div>

            <div>
              <p className="muted small" style={{ marginBottom: 6 }}>Click a placeholder to insert it at your cursor. The app fills it in automatically.</p>
              <div>
                {data.placeholders.map((p) => (
                  <span key={p.name} className="chip" title={p.description} onClick={() => insertPlaceholder(p.name)}>
                    {`{{${p.name}}}`}
                  </span>
                ))}
              </div>
            </div>

            <textarea ref={ta} className="mono" rows={24} value={draft} onChange={(e) => setDrafts({ ...drafts, [active]: e.target.value })} aria-label="Template text" />

            {unknown.length > 0 && (
              <div className="banner warn" style={{ marginBottom: 0 }}>
                Unknown placeholder{unknown.length > 1 ? 's' : ''}: {unknown.map((u) => `{{${u}}}`).join(', ')}. {unknown.length > 1 ? 'They' : 'It'} will be sent to Claude as plain text.
              </div>
            )}

            <div>
              <label className="field">Fixed output format (added automatically, not editable, so the app can always read Claude's answer)</label>
              <div className="locked mono">{t.locked}</div>
            </div>

            <div className="row">
              <button className="btn btn-primary" onClick={save} disabled={busy || !dirty || (!isBrand && !draft.trim())}>
                {busy ? 'Working...' : 'Save new version'}
              </button>
              {dirty && (
                <button className="btn btn-ghost" onClick={() => setDrafts({ ...drafts, [active]: t.content })}>
                  Discard changes
                </button>
              )}
              <div className="grow" />
              <button className="btn btn-danger" onClick={reset} disabled={busy || (isBrand ? t.source !== 'brand' : false)}>
                {isBrand ? 'Remove override' : 'Reset to default'}
              </button>
            </div>
          </section>

          {active === 'variations' && (
            <section className="panel stack">
              <div>
                <h2>Test this template</h2>
                <p className="muted small" style={{ marginTop: 3 }}>
                  Runs the text above, including unsaved edits, on a real image slot and shows the 3 prompt variations. Nothing is saved and no image is generated, so it costs very little.
                </p>
              </div>
              {data.testTargets.length === 0 ? (
                <p className="muted">Add a product with at least one photo first.</p>
              ) : (
                <div className="row">
                  <select value={testSlot} onChange={(e) => setTestSlot(e.target.value)} style={{ maxWidth: 380 }} aria-label="Image to test on">
                    {data.testTargets.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.brand} / {x.product} / image {x.position + 1} ({x.type})
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-quiet" onClick={runTest} disabled={testing || !testSlot}>
                    {testing ? 'Running...' : 'Run test'}
                  </button>
                </div>
              )}
              {testResult && (
                <div className="variations">
                  {testResult.variations.map((v, i) => (
                    <div key={i} className={`variation ${i === testResult.recommended ? 'rec' : ''}`}>
                      <div className="row" style={{ marginBottom: 8 }}>
                        <b>{v.label || `Variation ${i + 1}`}</b>
                        {i === testResult.recommended && <span className="badge warn">Claude recommends</span>}
                      </div>
                      <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{v.prompt}</pre>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="panel">
            <h2>Version history</h2>
            {t.history.length === 0 ? (
              <p className="muted small">No saved versions yet. The built-in default is in use.</p>
            ) : (
              <div>
                {t.history.map((h) => (
                  <div key={h.version} className="arow">
                    <b>v{h.version}</b>
                    <span className="muted small grow">
                      {new Date(h.created_at).toLocaleString()}
                      {h.content.trim() ? '' : ' (override removed)'}
                    </span>
                    {h.content.trim() && (
                      <button className="btn btn-ghost btn-sm" onClick={() => setDrafts({ ...drafts, [active]: h.content })}>
                        Load into editor
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
