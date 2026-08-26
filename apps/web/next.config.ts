import { resolve } from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

loadEnvConfig(resolve(import.meta.dirname, '../..'));

const nextConfig: NextConfig = {
  transpilePackages: ['@sgr-registry/contracts', '@sgr-registry/domain'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
        ],
      },
    ];
  },
};

export default nextConfig;
