'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DashboardProvider, useDashboard } from './DashboardContext.js';
import { Icon, Mark } from './ui.js';

export default function Shell({ children }) {
  const pathname = usePathname();
  if (pathname === '/login') return children;
  return (
    <DashboardProvider>
      <Frame pathname={pathname}>{children}</Frame>
    </DashboardProvider>
  );
}

function Frame({ pathname, children }) {
  const { data, openNewBrand } = useDashboard();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const brands = data?.brands || [];
  const setup = data?.setup;
  const cls = (active) => `nav-link ${active ? 'active' : ''}`;

  return (
    <div className="app">
      <div className="mobilebar">
        <button className="icon-btn" aria-label="Open menu" onClick={() => setOpen(true)}>
          <Icon name="menu" size={22} />
        </button>
        <span>Infographic Studio</span>
      </div>

      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Link href="/" className="brandmark">
          <Mark />
          <span>Infographic Studio</span>
        </Link>

        <nav>
          <Link href="/" className={cls(pathname === '/')}>
            <Icon name="home" />
            <span className="nav-label">Dashboard</span>
          </Link>
          <Link href="/settings/templates" className={cls(pathname.startsWith('/settings'))}>
            <Icon name="sliders" />
            <span className="nav-label">Prompt templates</span>
          </Link>
        </nav>

        <div className="nav-title">
          <span>Brand folders</span>
          <button className="icon-btn" onClick={openNewBrand} aria-label="New brand folder" title="New brand folder">
            <Icon name="plus" size={16} />
          </button>
        </div>
        <nav>
          {brands.map((b) => (
            <Link key={b.id} href={`/brands/${b.id}`} className={cls(pathname === `/brands/${b.id}`)}>
              <Icon name="folder" />
              <span className="nav-label">{b.name}</span>
              <span className="nav-count">{b.productCount}</span>
            </Link>
          ))}
          {data && brands.length === 0 && <p className="nav-empty">No brands yet.</p>}
        </nav>

        <div className="sidebar-foot">
          <div className="svc" title={setup && !setup.anthropic ? 'Add ANTHROPIC_API_KEY to .env.local' : 'Claude writes and reviews prompts'}>
            <span className="dot" data-s={setup ? (setup.anthropic ? 'approved' : 'error') : ''} />
            Claude {setup && !setup.anthropic ? 'key missing' : 'connected'}
          </div>
          <div className="svc" title={setup && !setup.gemini ? 'Add GEMINI_API_KEY to .env.local' : 'Nano Banana Pro draws the images'}>
            <span className="dot" data-s={setup ? (setup.gemini ? 'approved' : 'error') : ''} />
            Nano Banana Pro {setup && !setup.gemini ? 'key missing' : 'connected'}
          </div>
        </div>
      </aside>
      {open && <div className="scrim-side" onClick={() => setOpen(false)} />}

      <main className="main">{children}</main>
    </div>
  );
}
