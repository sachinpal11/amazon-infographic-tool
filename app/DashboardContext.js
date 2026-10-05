'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api } from './api-client.js';
import { NameModal } from './ui.js';

const Ctx = createContext(null);

// Loads the dashboard summary once for the whole app (sidebar and pages share it),
// refreshes when you navigate, and polls while anything is generating.
export function DashboardProvider({ children }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [brandModal, setBrandModal] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      setData(await api('/api/dashboard'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, pathname]);

  const live = !!data && data.stats.running > 0;
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [live, refresh]);

  const value = { data, error, refresh, openNewBrand: () => setBrandModal(true) };

  return (
    <Ctx.Provider value={value}>
      {children}
      {brandModal && (
        <NameModal
          title="New brand folder"
          label="Brand name"
          placeholder="e.g. Acme Outdoors"
          cta="Create brand"
          onClose={() => setBrandModal(false)}
          onSubmit={async (name) => {
            const { id } = await api('/api/brands', { method: 'POST', body: { name } });
            await refresh();
            setBrandModal(false);
            router.push(`/brands/${id}`);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

export const useDashboard = () => useContext(Ctx);
