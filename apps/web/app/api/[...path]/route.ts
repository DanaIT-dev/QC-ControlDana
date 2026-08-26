import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-encoding',
  'content-length',
]);

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  const upstreamUrl = new URL(`${apiBaseUrl()}/api/${path.join('/')}`);
  request.nextUrl.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.set(key, value);
  });

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  const method = request.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();

  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body,
    redirect: 'manual',
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      return;
    }
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
