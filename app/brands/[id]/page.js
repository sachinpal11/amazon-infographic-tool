import BrandClient from './BrandClient.js';

export default async function Page({ params }) {
  const { id } = await params;
  return <BrandClient id={Number(id)} />;
}
