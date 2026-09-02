import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildWebContentSecurityPolicy } from './lib/csp';
import { PERMISSIONS_POLICY, PRODUCTION_HSTS } from './lib/security-headers';

const SESSION_COOKIE_NAME = 'sgr_session';

function applySecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const csp = buildWebContentSecurityPolicy({
    nonce,
    isDevelopment,
  });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  if (!isDevelopment) {
    response.headers.set('Strict-Transport-Security', PRODUCTION_HSTS);
  }
  return response;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  if (pathname === '/' && !hasSession) {
    const destination = request.nextUrl.clone();
    destination.pathname = '/login';
    return applySecurityHeaders(NextResponse.redirect(destination), nonce);
  }

  if (
    (pathname === '/registry' ||
      pathname === '/super-admin' ||
      pathname === '/system-status' ||
      pathname === '/users' ||
      pathname === '/reference-data' ||
      pathname === '/change-password' ||
      pathname === '/notifications' ||
      pathname === '/deadlines' ||
      pathname === '/objects' ||
      pathname === '/pending-role' ||
      pathname.startsWith('/acts/')) &&
    !hasSession
  ) {
    const destination = request.nextUrl.clone();
    destination.pathname = '/login';
    return applySecurityHeaders(NextResponse.redirect(destination), nonce);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  return applySecurityHeaders(response, nonce);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|api/).*)'],
};
