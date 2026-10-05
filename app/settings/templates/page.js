import TemplatesClient from './TemplatesClient.js';

export default async function Page({ searchParams }) {
  const sp = await searchParams;
  const scope = typeof sp?.scope === 'string' ? sp.scope : 'global';
  return <TemplatesClient initialScope={scope} />;
}
