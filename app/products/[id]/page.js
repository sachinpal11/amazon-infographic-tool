import ProductClient from './ProductClient.js';

export default async function Page({ params }) {
  const { id } = await params;
  return <ProductClient id={Number(id)} />;
}
