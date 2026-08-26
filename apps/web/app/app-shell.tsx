import type { ReactNode } from 'react';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <div className="site-header__inner">
          <p className="site-header__eyebrow">Dana Holding · внутренний продукт</p>
          <p className="site-header__title">Реестр дефектных актов</p>
        </div>
      </header>
      <main className="site-main">{children}</main>
    </>
  );
}
