"use client";

import { Sidebar } from "./Sidebar";
import { ShellProvider, useShellMobileNav } from "./ShellContext";
import { TaskPanesProvider } from "./TaskPanesContext";
import { TaskPanesHost } from "@/components/task/TaskPanesHost";

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { mobileNavOpen, closeMobileNav } = useShellMobileNav();
  return (
    <div className="flex h-dvh flex-col bg-bg text-text md:flex-row">
      {/* Sidebar も provider 由来の activeTaskId でハイライトするためこの内側で囲む */}
      <TaskPanesProvider>
        <Sidebar mobileOpen={mobileNavOpen} onClose={closeMobileNav} />
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <section aria-label="メインコンテンツ" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {/* task path では panes ホストが描画を担い、page.tsx（null）を置き換える。
                Home / settings では従来どおり page の内容を出す。 */}
            <TaskPanesHost />
            {children}
          </section>
        </div>
      </TaskPanesProvider>
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
