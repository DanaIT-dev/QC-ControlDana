import type { ReactNode } from 'react';
import type { SafeUserProfile } from '@sgr-registry/contracts';
import { AppNav } from './app-nav';
import { LogoutButton } from './registry/logout-button';

export function AppShell({ user, children }: { user: SafeUserProfile; children: ReactNode }) {
  return (
    <>
      <header className="site-header">
        <div className="site-header__inner">
          <div className="site-header__brand">
            <p className="site-header__eyebrow">Dana Holding · внутренний продукт</p>
            <p className="site-header__title">Реестр дефектных актов</p>
          </div>
          <AppNav role={user.role} />
          <div className="site-header__user">
            <p className="site-header__who">
              <span className="site-header__name">{user.fullName}</span>
              <span className="site-header__role">{user.roleLabel}</span>
            </p>
            <LogoutButton csrfToken={user.csrfToken} className="ghost-button logout-button" />
          </div>
        </div>
      </header>
      <main className="site-main">{children}</main>
    </>
  );
}
