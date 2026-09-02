import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  hasCapability,
  isPendingRole,
  postLoginPath,
  SESSION_COOKIE_NAME,
} from '@sgr-registry/domain';
import type { CapabilitiesResponse, SafeUserProfile } from '@sgr-registry/contracts';

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
}

export async function sessionCookieHeader(): Promise<string | null> {
  const store = await cookies();
  const session = store.get(SESSION_COOKIE_NAME)?.value;
  if (!session) {
    return null;
  }
  return `${SESSION_COOKIE_NAME}=${session}`;
}

async function fetchApi<T>(path: string): Promise<{ status: number; data: T | null }> {
  const cookieHeader = await sessionCookieHeader();
  if (!cookieHeader) {
    return { status: 401, data: null };
  }
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    headers: { cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!response.ok) {
    return { status: response.status, data: null };
  }
  return { status: response.status, data: (await response.json()) as T };
}

export async function fetchCurrentUser(): Promise<SafeUserProfile | null> {
  const result = await fetchApi<SafeUserProfile>('/api/auth/me');
  return result.data;
}

export async function requireAppUser(): Promise<SafeUserProfile> {
  const user = await fetchCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (user.mustChangePassword) {
    redirect('/change-password');
  }
  return user;
}

export async function requireBusinessUser(): Promise<SafeUserProfile> {
  const user = await requireAppUser();
  if (isPendingRole(user.role)) {
    redirect('/pending-role');
  }
  return user;
}

export async function requireSuperAdminUser(): Promise<SafeUserProfile> {
  const user = await requireAppUser();
  if (!hasCapability(user.role, 'MANAGE_ADMIN_GRANTS')) {
    redirect(postLoginPath(user.role));
  }
  return user;
}

export async function fetchCapabilities(): Promise<CapabilitiesResponse | null> {
  const result = await fetchApi<CapabilitiesResponse>('/api/auth/capabilities');
  return result.data;
}

export async function fetchSystemStatus() {
  return fetchApi('/api/system-status');
}
