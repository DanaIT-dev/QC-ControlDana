'use client';

import type { ReactNode } from 'react';
import type { SafeUserProfile } from '@sgr-registry/contracts';
import { MenuIcon } from 'lucide-react';
import { useState } from 'react';
import { AppNav } from './app-nav';
import { QcLogo } from '@/components/qc-logo';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { MobileUserBlock, UserMenu } from '@/components/user-menu';

export function AppShell({ user, children }: { user: SafeUserProfile; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 border-b bg-white">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 md:h-[64px] md:px-6 lg:px-8">
          <QcLogo href="/registry" />
          <AppNav role={user.role} className="hidden md:flex" />
          <div className="ml-auto hidden md:block">
            <UserMenu user={user} />
          </div>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto md:hidden"
                aria-label="Открыть меню"
              >
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full max-w-sm sm:max-w-sm">
              <SheetHeader>
                <SheetTitle className="flex items-center">
                  <QcLogo size="sheet" decorative />
                  <span className="sr-only">QC.Dana</span>
                </SheetTitle>
              </SheetHeader>
              <div className="flex flex-1 flex-col gap-4 px-4 pb-6">
                <AppNav role={user.role} onNavigate={() => setOpen(false)} />
                <Separator />
                <MobileUserBlock user={user} />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] px-4 py-6 md:px-6 md:py-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
