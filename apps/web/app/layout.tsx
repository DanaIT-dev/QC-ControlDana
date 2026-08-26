import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Реестр дефектных актов',
  description: 'Техническое состояние системы реестра дефектных актов СГР',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <header className="site-header">
          <div className="site-header__inner">
            <p className="site-header__eyebrow">Dana Holding · внутренний продукт</p>
            <h1 className="site-header__title">Реестр дефектных актов</h1>
          </div>
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
