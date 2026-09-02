"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { AUTO_MODEL_VALUE } from "@/lib/auto-model";
import { writeAutoOptimizeMode } from "@/lib/auto-settings";
import { AUTO_AGENT_VALUE, writeStoredAgent } from "@/lib/default-agent";
import { writePermissionMode } from "@/lib/permission-gate";
import { writeSkillPermission } from "@/lib/skill-permission";
import { writeSubagentPermission } from "@/lib/subagent-permission";
import { Sidebar } from "./Sidebar";
import { ShellProvider, useShellMobileNav } from "./ShellContext";
import { TaskPanesProvider } from "./TaskPanesContext";
import { TaskPanesHost } from "@/components/task/TaskPanesHost";
import { cx } from "@/components/ui";
import { isSplitHostPath } from "@/lib/task-panes";

const COMPOSER_MODEL_STORAGE_KEY = "leafcodepi.defaultModel";
let composerDefaultsInitialized = false;

/** Reset Composer choices once per WebUI boot; later changes remain in this session. */
function initializeComposerDefaults(): void {
  if (composerDefaultsInitialized || typeof window === "undefined") return;
  composerDefaultsInitialized = true;
  try {
    window.localStorage.setItem(COMPOSER_MODEL_STORAGE_KEY, AUTO_MODEL_VALUE);
  } catch {
    /* private mode 等では既定値を state 側で使う */
  }
  writeAutoOptimizeMode("balanced");
  writeStoredAgent(AUTO_AGENT_VALUE);
  writePermissionMode("allow");
  writeSkillPermission("allow");
  writeSubagentPermission("deny");
}

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
            <Suspense fallback={null}>
              <TaskPanesHost />
            </Suspense>
            <div
              className={cx(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                isSplitHostPath(pathname) && (pathname === "/" ? "md:hidden" : "hidden"),
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
  initializeComposerDefaults();
  return (
    <ShellProvider>
      <AppShellInner>{children}</AppShellInner>
    </ShellProvider>
  );
}
