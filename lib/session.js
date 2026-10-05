// Edge-compatible (used by middleware): no Node-only imports here.
export async function sessionToken(password) {
  const data = new TextEncoder().encode('infographic-tool:' + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
