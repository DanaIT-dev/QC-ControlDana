export const APP_FOOTER_CREDIT = 'Inspired by Andrew Rodkevich';

export function AppFooter() {
  return (
    <footer data-slot="app-footer" className="border-t bg-white">
      <p className="mx-auto flex h-8 w-full min-w-0 max-w-[1600px] items-center justify-center px-3 text-center text-xs leading-none font-normal whitespace-nowrap text-muted-foreground">
        {APP_FOOTER_CREDIT}
      </p>
    </footer>
  );
}
