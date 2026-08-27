import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { loadConfig } from '@sgr-registry/config';
import { clientIp } from '../auth/request-meta';
import type { AuthenticatedUser } from '../auth/authenticated-user';

export function requestIdOf(request: FastifyRequest): string | null {
  const fromRequest = (request as FastifyRequest & { requestId?: string }).requestId;
  if (typeof fromRequest === 'string' && fromRequest.length > 0) {
    return fromRequest;
  }
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : null;
}

export function actorContext(user: AuthenticatedUser, request: FastifyRequest) {
  const config = loadConfig();
  return {
    actor: { id: user.id, fullName: user.fullName },
    requestId: requestIdOf(request),
    ipAddress: clientIp(request, config.TRUST_PROXY),
  };
}

export function canonicalRequestHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

export function readIdempotencyKey(request: FastifyRequest): string | null {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
