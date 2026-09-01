import { resolve } from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import { PERMISSIONS_POLICY, PRODUCTION_HSTS } from './lib/security-headers';

loadEnvConfig(resolve(import.meta.dirname, '../..'));

const nextConfig: NextConfig = {
  poweredByHeader: false,
  distDir: process.env.SGR_REQUIRE_E2E_TARGET === '1' ? '.next-e2e' : '.next',
  transpilePackages: ['@sgr-registry/contracts', '@sgr-registry/domain'],
  async headers() {
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-DNS-Prefetch-Control', value: 'off' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
    ];
    if (process.env.NODE_ENV === 'production') {
      securityHeaders.push({ key: 'Strict-Transport-Security', value: PRODUCTION_HSTS });
    }
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
