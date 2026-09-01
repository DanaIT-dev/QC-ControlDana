export function e2eWebOrigin(): string {
  return process.env.WEB_ORIGIN ?? 'http://127.0.0.1:3200';
}

export function e2eApiOrigin(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3201';
}
