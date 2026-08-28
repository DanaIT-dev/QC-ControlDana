export function buildWebContentSecurityPolicy(input: {
  nonce: string;
  isDevelopment: boolean;
}): string {
  const scriptSrc = input.isDevelopment
    ? `'self' 'nonce-${input.nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `'self' 'nonce-${input.nonce}' 'strict-dynamic'`;
  const connectSrc = input.isDevelopment
    ? `'self' ws://127.0.0.1:3000 ws://localhost:3000 wss://127.0.0.1:3000 wss://localhost:3000`
    : `'self'`;
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
  ].join('; ');
}

export function isProductionScriptCsp(policy: string): boolean {
  return (
    /script-src\s/.test(policy) &&
    !/script-src[^;]*'unsafe-eval'/.test(policy) &&
    /frame-ancestors 'none'/.test(policy)
  );
}
