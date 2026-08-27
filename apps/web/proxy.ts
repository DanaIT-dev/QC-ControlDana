import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE_NAME = 'sgr_session';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (pathname === '/') {
    const destination = request.nextUrl.clone();
    destination.pathname = hasSession ? '/registry' : '/login';
    return NextResponse.redirect(destination);
  }

  if (
    (pathname === '/registry' ||
      pathname === '/system-status' ||
      pathname === '/users' ||
      pathname === '/reference-data' ||
      pathname === '/change-password' ||
      pathname.startsWith('/acts/')) &&
    !hasSession
  ) {
    const destination = request.nextUrl.clone();
    destination.pathname = '/login';
    return NextResponse.redirect(destination);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/login',
    '/registry',
    '/system-status',
    '/users',
    '/users/:path*',
    '/reference-data',
    '/reference-data/:path*',
    '/change-password',
    '/acts/:path*',
  ],
};
