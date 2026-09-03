'use client';

import type { ReactNode } from 'react';
import type { SafeUserProfile } from '@sgr-registry/contracts';
import { isOversightRole, postLoginPath, satisfiesCapability } from '@sgr-registry/domain';
import { MenuIcon } from 'lucide-react';
import { useState } from 'react';
import { AppNav } from './app-nav';
import { AppFooter } from '@/components/app-footer';
import { NotificationBell } from '@/components/notification-bell';
import { QcLogo } from '@/components/qc-logo';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { MobileUserBlock, UserMenu } from '@/components/user-menu';

export function AppShell({ user, children }: { user: SafeUserProfile; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const homeHref = postLoginPath(user.role);
  const showNotifications = satisfiesCapability(user.role, 'VIEW_NOTIFICATIONS');
  const readOnly = isOversightRole(user.role);
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-40 overflow-visible border-b bg-white">
        <div
          data-slot="app-header"
          className="mx-auto flex h-16 w-full min-w-0 max-w-[1600px] flex-nowrap items-center gap-2 px-3 xl:gap-2 xl:px-4 2xl:gap-3 2xl:px-6"
        >
          <div data-slot="app-logo" className="shrink-0">
            <QcLogo href={homeHref} />
          </div>
          <AppNav
            role={user.role}
            variant="desktop"
            className="hidden min-w-0 flex-1 flex-nowrap xl:flex"
          />
          <div
            data-slot="app-header-actions"
            className="ml-auto flex shrink-0 flex-nowrap items-center gap-1"
          >
            {readOnly ? (
              <span className="hidden shrink-0 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] leading-none font-medium text-muted-foreground xl:inline">
                Режим просмотра
              </span>
            ) : null}
            <div className="hidden items-center gap-1 xl:flex">
              {showNotifications ? (
                <NotificationBell csrfToken={user.csrfToken} canMutate={!readOnly} />
              ) : null}
              <UserMenu user={user} />
            </div>
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="xl:hidden"
                  aria-label="Открыть меню"
                >
                  <MenuIcon />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="z-[70] w-full max-w-sm sm:max-w-sm">
                <SheetHeader>
                  <SheetTitle className="flex items-center">
                    <QcLogo size="sheet" decorative />
                    <span className="sr-only">QC.Dana</span>
                  </SheetTitle>
                </SheetHeader>
                <div className="flex flex-1 flex-col gap-4 px-4 pb-6">
                  {showNotifications ? (
                    <div className="flex items-center justify-end gap-2">
                      {readOnly ? (
                        <span className="shrink-0 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          Режим просмотра
                        </span>
                      ) : null}
                      <NotificationBell csrfToken={user.csrfToken} canMutate={!readOnly} />
                    </div>
                  ) : readOnly ? (
                    <p className="text-right text-[11px] font-medium whitespace-nowrap text-muted-foreground">
                      Режим просмотра
                    </p>
                  ) : null}
                  <AppNav role={user.role} variant="drawer" onNavigate={() => setOpen(false)} />
                  <Separator />
                  <MobileUserBlock user={user} />
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 flex-1 max-w-[1600px] px-3 py-6 md:px-6 md:py-6 lg:px-8 xl:px-4 2xl:px-6">
        {children}
      </main>
      <AppFooter />
    </div>
  );
}
