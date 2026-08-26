import type { FastifyRequest } from 'fastify';

export function clientIp(request: FastifyRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
      const first = forwarded.split(',')[0]?.trim();
      if (first) {
        return first;
      }
    }
  }
  return request.ip || request.socket.remoteAddress || '0.0.0.0';
}

export function isAllowedOrigin(origin: string | undefined, webOrigin: string): boolean {
  if (!origin) {
    return true;
  }
  return origin === webOrigin;
}
