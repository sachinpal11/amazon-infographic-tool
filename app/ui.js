'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const PATHS = {
  home: <path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M21 16l-5-5-8 8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4-4" />
    </>
  ),
  sliders: <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />,
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.2v.1" />
    </>
  ),
};

export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Mark({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="9" width="17" height="17" rx="4" fill="#14575b" stroke="#2c8a8f" strokeWidth="1.4" />
      <rect x="8" y="5" width="17" height="17" rx="4" fill="#1d7a7f" stroke="#4aa9ad" strokeWidth="1.4" />
      <rect x="14" y="1.5" width="16" height="16" rx="4" fill="#f2a93b" />
    </svg>
  );
}

export const STATUS = {
  empty: ['', 'Not started'],
  prompting: ['busy', 'Writing prompts'],
  choose: ['warn', 'Choose a prompt'],
  generating: ['busy', 'Generating'],
  review: ['warn', 'Review image'],
  approved: ['ok', 'Approved'],
  error: ['err', 'Error'],
};

export const TYPE_OPTIONS = [
  ['features', 'Features'],
  ['benefits', 'Benefits'],
  ['dimensions', 'Dimensions / size'],
  ['comparison', 'Comparison'],
  ['how_to_use', 'How to use'],
  ['whats_in_box', "What's in the box"],
  ['other', 'Other'],
];
export const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS);

export function StatusDot({ status }) {
  return <span className="dot" data-s={status} title={(STATUS[status] || ['', status])[1]} />;
}

export function Avatar({ name, logo, large }) {
  return (
    <span className={`avatar ${large ? 'lg' : ''}`}>
      {logo ? <img src={`/api/files/${logo}`} alt="" /> : (name || '?').trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function Crumbs({ items }) {
  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {items.map((it, i) => (
        <span key={i} className="row" style={{ gap: 6 }}>
          {i > 0 && <Icon name="chevron" size={13} />}
          {it.href ? <Link href={it.href}>{it.label}</Link> : <span className="cur">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Small "name it" dialog used for creating brands and products.
export function NameModal({ title, label, placeholder, cta, onSubmit, onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(name.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div>
          <label className="field" htmlFor="name-modal-input">{label}</label>
          <input id="name-modal-input" type="text" autoFocus value={name} placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
        </div>
        {error && <div className="banner err">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating...' : cta}
          </button>
        </div>
      </form>
    </Modal>
  );
}
