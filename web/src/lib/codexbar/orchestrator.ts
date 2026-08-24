/**
 * Parallel native usage fetch + snapshot assembly.
 *
 * Rate limiting / concurrency:
 * - Aggregate in-memory cache (~5 min)
 * - Per-provider cache + 429 backoff (Claude especially)
 * - In-flight promise coalescing (Strict Mode / multi-tab races)
 */

import { emptyUsage, type CodexBarUsage } from "@/lib/codexbar";
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
import {
  peekLastGood,
  setProviderCacheError,
  setProviderCacheOk,
  shouldSkipProviderFetch,
} from "@/lib/codexbar/provider-cache";
import { NATIVE_PROVIDERS } from "@/lib/codexbar/providers";
import { ProviderError, type ProviderFetchResult } from "@/lib/codexbar/types";

export type FetchUsageOptions = {
  /** Bypass aggregate + per-provider success caches (429 backoff still applies). */
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

function resultFromCache(
  provider: (typeof NATIVE_PROVIDERS)[number],
  cached: NonNullable<ReturnType<typeof shouldSkipProviderFetch>>,
): ProviderFetchResult {
  if (cached.kind === "ok" && cached.snapshot) {
    return {
      id: provider.id,
      name: provider.name,
      configured: true,
      snapshot: cached.snapshot,
      error: null,
    };
  }

  // Prefer last-good during rate-limit / soft errors so the UI stays useful.
  if (cached.lastGood) {
    return {
      id: provider.id,
      name: provider.name,
      configured: true,
      snapshot: { ...cached.lastGood, isStale: true },
      error: cached.kind === "rate_limit" ? cached.error : null,
    };
  }

  return {
    id: provider.id,
    name: provider.name,
    configured: true,
    snapshot: null,
    error: cached.error,
  };
}

async function fetchOne(
  provider: (typeof NATIVE_PROVIDERS)[number],
  forceRefresh: boolean,
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

  const cached = shouldSkipProviderFetch(provider.id, forceRefresh);
  if (cached) return resultFromCache(provider, cached);

  try {
    const snapshot = await provider.fetch(signal);
    setProviderCacheOk(provider.id, snapshot);
    return {
      id: provider.id,
      name: provider.name,
      configured: true,
      snapshot,
      error: null,
    };
  } catch (err) {
    const rateLimited =
      err instanceof ProviderError
        ? err.isRateLimit
        : err instanceof Error && /レート制限|rate.?limit|429/i.test(err.message);
    const message =
      err instanceof ProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    setProviderCacheError(provider.id, message, rateLimited);

    const lastGood = peekLastGood(provider.id);
    if (lastGood && rateLimited) {
      return {
        id: provider.id,
        name: provider.name,
        configured: true,
        snapshot: { ...lastGood, isStale: true },
        error: message,
      };
    }

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
} {
  const entries: ExportEntry[] = [];
  let anyConfigured = false;

  for (const r of results) {
    if (!r.configured) continue;
    anyConfigured = true;
    const entry = buildEntry(r.id, r.snapshot, r.error);
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    return {
      usage: emptyUsage("設定済みのプロバイダーがありません"),
      anyConfigured,
    };
  }

  return {
    usage: buildUsageFromEntries(entries),
    anyConfigured,
  };
}

async function fetchNativeUsageUncached(
  options: FetchUsageOptions,
): Promise<CodexBarUsage> {
  const { forceRefresh = false, signal } = options;
  const enabledIds = new Set<string>(resolveEnabledProviderIds());

  const providers = NATIVE_PROVIDERS.filter((p) => enabledIds.has(p.id));
  const results = await Promise.all(
    providers.map((p) => fetchOne(p, forceRefresh, signal)),
  );
  const { usage, anyConfigured } = assembleFromResults(results);

  if (anyConfigured) {
    setCachedUsage(usage);
    return usage;
  }

  return emptyUsage(
    "利用状況を取得できるプロバイダーが設定されていません（Codex / Claude / Cursor 等にサインインするか、API キーを設定してください）",
  );
}

/** Coalesce concurrent aggregate fetches (same force flag). */
let inflight: {
  force: boolean;
  promise: Promise<CodexBarUsage>;
} | null = null;

/**
 * Fetch usage: aggregate cache → native parallel (per-provider cache).
 */
export async function fetchNativeUsage(
  options: FetchUsageOptions = {},
): Promise<CodexBarUsage> {
  const forceRefresh = options.forceRefresh === true;

  if (!forceRefresh) {
    const cached = getCachedUsage();
    if (cached) return cached;
  } else {
    clearCachedUsage();
  }

  if (inflight && inflight.force === forceRefresh) {
    return inflight.promise;
  }

  const promise = fetchNativeUsageUncached(options).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { force: forceRefresh, promise };
  return promise;
}
