"use client";

import { Sidebar } from "./Sidebar";
import { ShellProvider, useShellMobileNav } from "./ShellContext";

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { mobileNavOpen, closeMobileNav } = useShellMobileNav();
  return (
    <div className="flex h-dvh flex-col bg-bg text-text md:flex-row">
      <Sidebar mobileOpen={mobileNavOpen} onClose={closeMobileNav} />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <section aria-label="メインコンテンツ" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </section>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ShellProvider>
      <AppShellInner>{children}</AppShellInner>
    </ShellProvider>
  );
}
