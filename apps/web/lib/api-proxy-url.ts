const UNSAFE_SEGMENT = /^(?:\.{1,}|%2e(?:%2e)?)$/i;

export function isSafeApiPathSegment(segment: string): boolean {
  if (!segment || segment.length > 256) {
    return false;
  }
  if (UNSAFE_SEGMENT.test(segment)) {
    return false;
  }
  if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
    return false;
  }
  if (segment.includes('%2f') || segment.includes('%2F') || segment.includes('%5c')) {
    return false;
  }
  return true;
}

export function buildUpstreamApiUrl(
  apiBaseUrl: string,
  segments: string[],
  searchParams: URLSearchParams,
): URL {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('invalid_api_path');
  }
  if (!segments.every(isSafeApiPathSegment)) {
    throw new Error('invalid_api_path');
  }

  const base = new URL(apiBaseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, '')}/api`;
  const upstream = new URL(base.origin);
  upstream.pathname = `${prefix}/${segments.join('/')}`;
  searchParams.forEach((value, key) => {
    upstream.searchParams.set(key, value);
  });

  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  if (upstream.origin !== base.origin || !`${upstream.pathname}/`.startsWith(normalizedPrefix)) {
    throw new Error('invalid_api_path');
  }
  return upstream;
}
