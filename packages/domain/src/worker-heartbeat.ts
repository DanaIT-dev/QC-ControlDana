export const WORKER_HEARTBEAT_TTL_SECONDS = 15;
export const WORKER_HEARTBEAT_REFRESH_MS = 5_000;
export const WORKER_READY_TIMEOUT_MS = 10_000;

export function resolveWorkerHeartbeatKey(nodeEnv = process.env.NODE_ENV): string {
  return nodeEnv === 'test' ? 'sgr:worker:heartbeat:test' : 'sgr:worker:heartbeat';
}

export function resolveSlaEvaluationLockKey(
  businessDate: string,
  nodeEnv = process.env.NODE_ENV,
): string {
  const prefix = nodeEnv === 'test' ? 'sgr-test' : 'sgr';
  return `${prefix}:sla:eval:${businessDate}`;
}

export interface WorkerHeartbeatPayload {
  pid: number;
  startedAt: string;
  updatedAt: string;
}

export function serializeWorkerHeartbeat(input: WorkerHeartbeatPayload): string {
  return JSON.stringify({
    pid: input.pid,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
  });
}

export function parseWorkerHeartbeat(
  raw: string | null,
  now = new Date(),
): {
  status: 'up' | 'down';
  ageMs: number | null;
} {
  if (!raw) {
    return { status: 'down', ageMs: null };
  }
  try {
    const parsed = JSON.parse(raw) as { updatedAt?: string };
    if (typeof parsed.updatedAt !== 'string') {
      return { status: 'down', ageMs: null };
    }
    const updated = Date.parse(parsed.updatedAt);
    if (!Number.isFinite(updated)) {
      return { status: 'down', ageMs: null };
    }
    return { status: 'up', ageMs: Math.max(0, now.getTime() - updated) };
  } catch {
    return { status: 'down', ageMs: null };
  }
}
