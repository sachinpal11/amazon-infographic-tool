import { NextResponse } from 'next/server';
import { sessionToken } from './lib/session.js';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login|api/login).*)'],
};

export async function middleware(req) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next(); // login disabled
  const cookie = req.cookies.get('session')?.value;
  if (cookie && cookie === (await sessionToken(password))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', req.url));
}
