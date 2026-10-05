import { NextResponse } from 'next/server';
import { sessionToken } from '@/lib/session.js';

export async function POST(req) {
  const password = process.env.APP_PASSWORD;
  const body = await req.json().catch(() => ({}));
  if (!password) return NextResponse.json({ ok: true });
  if (body.password !== password) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set('session', await sessionToken(password), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
