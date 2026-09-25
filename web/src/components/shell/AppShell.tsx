"use client";

import { Suspense, useEffect } from "react";
import { usePathname } from "next/navigation";
import { writeAutoOptimizeMode } from "@/lib/auto-settings";
import { readComposerDefaults } from "@/lib/composer-defaults";
import { writeStoredAgent } from "@/lib/default-agent";
import { writePermissionMode } from "@/lib/permission-gate";
import { writeSkillPermission } from "@/lib/skill-permission";
import { writeSubagentPermission } from "@/lib/subagent-permission";
import { hydrateServerSettings, primeServerSettings, refreshServerSettings } from "@/lib/setting-sync";
import { writeStoredThinkingLevel } from "@/lib/thinking-levels";
import { Sidebar } from "./Sidebar";
import { ShellProvider, useShellMobileNav } from "./ShellContext";
import { TaskPanesProvider, useTaskPanesNavigation } from "./TaskPanesContext";
import { GlobalAttentionProvider } from "./GlobalAttentionProvider";
import { TaskPanesHost } from "@/components/task/TaskPanesHost";
import { cx } from "@/components/ui";
import { isBotTabId, isSplitHostPath } from "@/lib/task-panes";

const COMPOSER_MODEL_STORAGE_KEY = "leafcodepi.defaultModel";
let composerDefaultsInitialized = false;
/** タブ復帰時の再取得の最短間隔。 */
export const SETTINGS_REFRESH_INTERVAL_MS = 10_000;

/** Reset Composer choices once per WebUI boot; later changes remain in this session. */
function initializeComposerDefaults(): void {
  if (composerDefaultsInitialized || typeof window === "undefined") return;
  composerDefaultsInitialized = true;
  const defaults = readComposerDefaults();
  try {
    window.localStorage.setItem(COMPOSER_MODEL_STORAGE_KEY, defaults.model);
  } catch {
    /* private mode 等では既定値を state 側で使う */
  }
  writeAutoOptimizeMode(defaults.autoOptimize);
  writeStoredAgent(defaults.agent);
  if (defaults.thinkingLevel) writeStoredThinkingLevel(defaults.thinkingLevel);
  writePermissionMode("allow");
  writeSkillPermission("allow");
  writeSubagentPermission("deny");
}

/** 起動ごとに1回: サーバ値（正本）をキャッシュへ反映してから Composer 既定値を適用する。 */
function initializeBoot(initialSettings: Record<string, string | null> | undefined): void {
  if (composerDefaultsInitialized || typeof window === "undefined") return;
  if (initialSettings) primeServerSettings(initialSettings);
  initializeComposerDefaults();
  // 埋め込みが無い場合（描画時に読めなかった等）は後追いで取得する。起動時既定値は適用済みのキャッシュ値。
  if (!initialSettings) void hydrateServerSettings();
}

/** テスト用: 起動状態を初期化する。 */
export function resetAppShellBootForTests(): void {
  composerDefaultsInitialized = false;
}

/** 他PCでの設定変更を、タブへ戻ったときに取り込む。 */
function useServerSettingsRefresh(): void {
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < SETTINGS_REFRESH_INTERVAL_MS) return;
      last = now;
      void refreshServerSettings();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
}

function AppShellContent({
  children,
  mobileNavOpen,
  closeMobileNav,
}: {
  children: React.ReactNode;
  mobileNavOpen: boolean;
  closeMobileNav: () => void;
}) {
  const pathname = usePathname();
  const { mdUp } = useTaskPanesNavigation();
  const splitHomeOwnsContent = pathname === "/" && mdUp;
  return (
    <>
      <Sidebar mobileOpen={mobileNavOpen} onClose={closeMobileNav} />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <section aria-label="メインコンテンツ" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/* task / 「/」（新規作成タブ）/ settings では panes ホストが描画を担う。
              page 側の内容はモバイル（md未満）でのみ出す（「/」の HomeView 用）。 */}
          <Suspense fallback={null}>
            <TaskPanesHost />
          </Suspense>
          {!splitHomeOwnsContent && !isBotTabId(pathname) && (
            <div
              className={cx(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                isSplitHostPath(pathname) && (pathname === "/" ? "md:hidden" : "hidden"),
              )}
            >
              {children}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { mobileNavOpen, closeMobileNav } = useShellMobileNav();
  return (
    <div className="flex h-dvh flex-col bg-bg text-text md:flex-row">
      {/* Sidebar も provider 由来の activeTaskId でハイライトするためこの内側で囲む */}
      <TaskPanesProvider>
        <AppShellContent
          mobileNavOpen={mobileNavOpen}
          closeMobileNav={closeMobileNav}
        >
          {children}
        </AppShellContent>
        <GlobalAttentionProvider />
      </TaskPanesProvider>
    </div>
  );
}

export function AppShell({
  children,
  initialSettings,
}: {
  children: React.ReactNode;
  /** (app)/layout がサーバ描画時に埋め込む設定スナップショット。 */
  initialSettings?: Record<string, string | null>;
}) {
  initializeBoot(initialSettings);
  useServerSettingsRefresh();
  return (
    <ShellProvider>
      <AppShellInner>{children}</AppShellInner>
    </ShellProvider>
  );
}
