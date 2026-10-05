'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api-client.js';

// A small "add something" form: one text input and a button.
export default function NewItem({ label, placeholder, endpoint, extra = {}, redirectPrefix, goTo }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await api(endpoint, { method: 'POST', body: { name: name.trim(), ...extra } });
      if (redirectPrefix) {
        router.push(`${redirectPrefix}/${id}`);
      } else if (typeof goTo === 'function') {
        router.push(goTo(id));
      } else if (typeof goTo === 'string') {
        router.push(`${goTo}/${id}`);
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="secondary small" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <form onSubmit={submit} className="row">
      <input type="text" autoFocus placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} style={{ width: 240 }} />
      <button type="submit" className="small" disabled={busy || !name.trim()}>
        {busy ? 'Creating...' : 'Create'}
      </button>
      <button type="button" className="ghost small" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="badge err">{error}</span>}
    </form>
  );
}
