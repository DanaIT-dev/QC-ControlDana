import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { Inter } from 'next/font/google';
import { Providers } from './providers';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'Реестр дефектных актов',
  description: 'Реестр дефектных актов Службы гарантийного ремонта Dana Holding',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="ru" className={inter.variable}>
      <body className="font-sans">
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  );
}
