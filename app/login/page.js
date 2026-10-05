'use client';

import { useState } from 'react';
import { api } from '../api-client.js';
import { Mark } from '../ui.js';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/login', { method: 'POST', body: { password } });
      window.location.href = '/';
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card stack" onSubmit={submit}>
        <div className="brandmark">
          <Mark size={34} />
          <span>Infographic Studio</span>
        </div>
        <div>
          <h1 style={{ fontSize: 24 }}>Sign in</h1>
          <p className="muted small" style={{ marginTop: 4 }}>Enter the team password to open the studio.</p>
        </div>
        <div>
          <label className="field" htmlFor="pw">Team password</label>
          <input id="pw" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <div className="banner err">{error}</div>}
        <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy || !password}>
          {busy ? 'Checking...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
