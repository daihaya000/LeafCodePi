/**
 * Parallel native usage fetch + snapshot assembly.
 *
 * Prefer native provider APIs always when any provider is configured.
 * Optional FALLBACK: if ALL native providers are unconfigured OR every
 * configured fetch fails, and a CodexBar usage-snapshot.json exists, read
 * that file as a last resort only (not the primary path).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyUsage,
  parseCodexBarSnapshot,
  type CodexBarUsage,
} from "@/lib/codexbar";
import {
  clearCachedUsage,
  getCachedUsage,
  setCachedUsage,
} from "@/lib/codexbar/cache";
import {
  buildEntry,
  buildUsageFromEntries,
  type ExportEntry,
} from "@/lib/codexbar/export";
import { resolveEnabledProviderIds } from "@/lib/codexbar/provider-catalog";
import { NATIVE_PROVIDERS } from "@/lib/codexbar/providers";
import { ProviderError, type ProviderFetchResult } from "@/lib/codexbar/types";

export type FetchUsageOptions = {
  /** Bypass in-memory cache (e.g. ?refresh=1). */
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

function snapshotFilePath(): string {
  const override = process.env.LEAFCODE_CODEXBAR_SNAPSHOT;
  if (override?.trim()) return override.trim();
  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "CodexBar", "usage-snapshot.json");
}

function filterUsageToEnabled(
  usage: CodexBarUsage,
  enabledIds: ReadonlySet<string>,
): CodexBarUsage {
  const providers = usage.providers.filter((p) => enabledIds.has(p.id));
  if (providers.length === 0) {
    return emptyUsage("有効なプロバイダーの利用状況がありません");
  }
  return { ...usage, providers, available: true };
}

async function readSnapshotFileFallback(
  enabledIds: ReadonlySet<string>,
): Promise<CodexBarUsage | null> {
  const file = snapshotFilePath();
  try {
    let text = await fs.readFile(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const json: unknown = JSON.parse(text);
    const usage = parseCodexBarSnapshot(json);
    if (!usage.available) return null;
    return filterUsageToEnabled(usage, enabledIds);
  } catch {
    return null;
  }
}

async function fetchOne(
  provider: (typeof NATIVE_PROVIDERS)[number],
  signal?: AbortSignal,
): Promise<ProviderFetchResult> {
  const configured = provider.isConfigured();
  if (!configured) {
    return {
      id: provider.id,
      name: provider.name,
      configured: false,
      snapshot: null,
      error: null,
    };
  }
  try {
    const snapshot = await provider.fetch(signal);
    return {
      id: provider.id,
      name: provider.name,
      configured: true,
      snapshot,
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      id: provider.id,
      name: provider.name,
      configured: true,
      snapshot: null,
      error: message,
    };
  }
}

function assembleFromResults(results: ProviderFetchResult[]): {
  usage: CodexBarUsage;
  anyConfigured: boolean;
  anySuccess: boolean;
} {
  const entries: ExportEntry[] = [];
  let anyConfigured = false;
  let anySuccess = false;

  for (const r of results) {
    if (!r.configured) continue;
    anyConfigured = true;
    if (r.snapshot) anySuccess = true;
    const entry = buildEntry(r.id, r.snapshot, r.error);
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    return {
      usage: emptyUsage("設定済みのプロバイダーがありません"),
      anyConfigured,
      anySuccess,
    };
  }

  return {
    usage: buildUsageFromEntries(entries),
    anyConfigured,
    anySuccess,
  };
}

/**
 * Fetch usage: cache → native parallel → optional snapshot-file last resort.
 *
 * Debug: LEAFCODE_CODEXBAR_FORCE_SNAPSHOT=1 skips native and reads the snapshot
 * file only (path from LEAFCODE_CODEXBAR_SNAPSHOT or default APPDATA location).
 */
export async function fetchNativeUsage(
  options: FetchUsageOptions = {},
): Promise<CodexBarUsage> {
  const { forceRefresh = false, signal } = options;
  const enabledIds = new Set<string>(resolveEnabledProviderIds());

  if (process.env.LEAFCODE_CODEXBAR_FORCE_SNAPSHOT === "1") {
    const file = await readSnapshotFileFallback(enabledIds);
    return (
      file ??
      emptyUsage(
        "デバッグ用スナップショットが見つかりません（LEAFCODE_CODEXBAR_FORCE_SNAPSHOT）",
      )
    );
  }

  if (!forceRefresh) {
    const cached = getCachedUsage();
    if (cached) return cached;
  } else {
    clearCachedUsage();
  }

  const providers = NATIVE_PROVIDERS.filter((p) => enabledIds.has(p.id));
  const results = await Promise.all(
    providers.map((p) => fetchOne(p, signal)),
  );
  const { usage, anyConfigured, anySuccess } = assembleFromResults(results);

  // Prefer native whenever any provider is configured and at least one succeeded.
  if (anyConfigured && anySuccess) {
    setCachedUsage(usage);
    return usage;
  }

  // LAST RESORT ONLY: CodexBarWin (or other exporter) left a snapshot on disk.
  // Do not use this as the primary path when native credentials exist and work.
  const fallback = await readSnapshotFileFallback(enabledIds);
  if (fallback) {
    setCachedUsage(fallback);
    return fallback;
  }

  if (anyConfigured && !anySuccess) {
    // Surface error entries from native rather than empty.
    setCachedUsage(usage);
    return usage;
  }

  const reason = anyConfigured
    ? "プロバイダーの取得に失敗しました"
    : "利用状況を取得できるプロバイダーが設定されていません（Codex / Claude / Cursor 等にサインインするか、API キーを設定してください）";
  const empty = emptyUsage(reason);
  // Do not cache hard failures long — allow quick recovery after login.
  return empty;
}
