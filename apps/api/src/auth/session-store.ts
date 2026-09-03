export interface StoredSession {
  userId: string;
  sessionVersion: number;
  csrfToken: string;
  createdAt: string;
  lastActivityAt: string;
  absoluteExpiresAt: string;
}

export interface LoginRateLimitState {
  count: number;
  ttlSeconds: number;
  limited: boolean;
}

export interface SessionStore {
  save(
    sessionHash: string,
    userId: string,
    session: StoredSession,
    ttlSeconds: number,
  ): Promise<void>;
  get(sessionHash: string): Promise<StoredSession | null>;
  delete(sessionHash: string, userId: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<void>;
  countForUsers(userIds: readonly string[]): Promise<Map<string, number>>;
  peekLoginFailures(email: string, ip: string): Promise<{ emailCount: number; ipCount: number }>;
  incrementLoginFailures(
    email: string,
    ip: string,
    emailLimit: number,
    ipLimit: number,
    windowSeconds: number,
  ): Promise<LoginRateLimitState>;
  resetLoginFailures(email: string, ip: string): Promise<void>;
}
