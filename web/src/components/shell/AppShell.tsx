"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { ShellProvider, useShellMobileNav } from "./ShellContext";
import { TaskPanesProvider } from "./TaskPanesContext";
import { TaskPanesHost } from "@/components/task/TaskPanesHost";
import { cx } from "@/components/ui";
import { isSplitHostPath } from "@/lib/task-panes";

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { mobileNavOpen, closeMobileNav } = useShellMobileNav();
  const pathname = usePathname();
  return (
    <div className="flex h-dvh flex-col bg-bg text-text md:flex-row">
      {/* Sidebar も provider 由来の activeTaskId でハイライトするためこの内側で囲む */}
      <TaskPanesProvider>
        <Sidebar mobileOpen={mobileNavOpen} onClose={closeMobileNav} />
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <section aria-label="メインコンテンツ" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {/* task / 「/」（新規作成タブ）では panes ホストが描画を担う。
                page 側の内容はモバイル（md未満）でのみ出す（「/」の HomeView 用）。
                settings では従来どおり page の内容を出す。 */}
            <TaskPanesHost />
            <div
              className={cx(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                isSplitHostPath(pathname) && "max-md:hidden",
              )}
            >
              {children}
            </div>
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
