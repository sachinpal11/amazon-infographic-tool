import fs from 'node:fs';
import { absPath } from '@/lib/db.js';
import { json, handle, HttpError } from '@/lib/http.js';

export const dynamic = 'force-dynamic';

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export const GET = handle(async (req, { params }) => {
  const { path: parts } = await params;
  const rel = parts.join('/');
  let file;
  try {
    file = absPath(rel);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (!fs.existsSync(file)) throw new HttpError(404, 'File not found');
  const ext = file.split('.').pop().toLowerCase();
  return new Response(fs.readFileSync(file), {
    headers: {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
});
