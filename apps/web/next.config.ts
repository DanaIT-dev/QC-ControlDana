import { resolve } from 'node:path';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

loadEnvConfig(resolve(import.meta.dirname, '../..'));

const nextConfig: NextConfig = {
  transpilePackages: ['@sgr-registry/contracts'],
};

export default nextConfig;
