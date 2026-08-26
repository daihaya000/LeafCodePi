/**
 * Parallel native usage fetch + snapshot assembly.
 *
 * Rate limiting / concurrency:
 * - Aggregate in-memory cache (~5 min)
 * - Per-scope provider cache + 429 backoff
 * - In-flight promise coalescing (Strict Mode / multi-tab races)
 */

import {
  accountAuthPath,
  accountHasProvider,
  getAccount,
  listAccounts,
  resolvePiAgentDir,
  type AccountRecord,
} from "@/lib/accounts";
import { emptyUsage, type CodexBarUsage } from "@/lib/codexbar";
import {
  clearCachedUsage,
  getCachedUsageForKey,
  setCachedUsage,
} from "@/lib/codexbar/cache";
import {
  buildEntry,
  buildUsageFromEntries,
  type ExportAccountSummary,
  type ExportEntry,
  type ExportScope,
} from "@/lib/codexbar/export";
import { resolveEnabledProviderIds } from "@/lib/codexbar/provider-catalog";
import {
  peekLastGood,
  setProviderCacheError,
  setProviderCacheOk,
  shouldSkipProviderFetch,
} from "@/lib/codexbar/provider-cache";
import { NATIVE_PROVIDER_DEFINITIONS } from "@/lib/codexbar/providers";
import {
  ProviderError,
  type UsageProviderDefinition,
  type UsageProviderInstance,
  type UsageScope,
  type ProviderFetchResult,
} from "@/lib/codexbar/types";
import { readPiOAuthTokens } from "@/lib/codexbar/pi-auth";

const MAX_CONCURRENT_FETCHES = 4;

export type UsageRequestScope =
  | { kind: "all"; accountId?: null }
  | { kind: "default"; accountId?: null }
  | { kind: "account"; accountId: string };

export type FetchUsageOptions = {
  /** Bypass aggregate + per-provider success caches (429 backoff still applies). */
  forceRefresh?: boolean;
  signal?: AbortSignal;
  scope?: UsageRequestScope;
};

type FetchPlan = {
  requestScope: UsageRequestScope;
  enabledIds: string[];
  providers: UsageProviderInstance[];
  cacheKey: string;
  metadata: {
    scope: ExportScope;
    accounts: ExportAccountSummary[];
    providerOrder: string[];
  };
};

function instanceId(scope: UsageScope, providerId: string): string {
  return scope.kind === "account"
    ? `account:${scope.accountId}:${providerId}`
    : `default:${providerId}`;
}

function createProviderInstance(
  definition: UsageProviderDefinition,
  scope: UsageScope,
): UsageProviderInstance {
  const provider = definition.create(scope);
  return {
    ...provider,
    instanceId: instanceId(scope, definition.id),
    accountId: scope.accountId,
    accountLabel: scope.accountLabel,
    scope,
  };
}

function accountSummary(
  account: AccountRecord,
  agentDir: string,
  enabledIds: readonly string[],
): ExportAccountSummary {
  const providers = account.providers.filter((provider) => enabledIds.includes(provider));
  const configuredProviders = providers.filter(
    (provider) =>
      readPiOAuthTokens(provider, {
        authPath: accountAuthPath(account.id, agentDir),
      }) !== null,
  );
  return {
    id: account.id,
    label: account.label,
    providers,
    configuredProviders,
  };
}

function rosterKey(accounts: readonly ExportAccountSummary[]): string {
  return JSON.stringify(accounts);
}

async function buildFetchPlan(requestScope: UsageRequestScope): Promise<FetchPlan> {
  const enabledIds = resolveEnabledProviderIds();
  const definitionsById = new Map(
    NATIVE_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition]),
  );
  const definitions = enabledIds.flatMap((id) => {
    const definition = definitionsById.get(id);
    return definition ? [definition] : [];
  });

  let accounts: AccountRecord[] = [];
  let agentDir: string | null = null;
  if (requestScope.kind === "all") {
    accounts = listAccounts();
  } else if (requestScope.kind === "account") {
    const account = getAccount(requestScope.accountId);
    if (!account) {
      throw Object.assign(new Error("アカウントが見つかりません"), { status: 404 });
    }
    accounts = [account];
  }
  if (accounts.length > 0) agentDir = await resolvePiAgentDir();

  const summaries = agentDir
    ? accounts.map((account) => accountSummary(account, agentDir!, enabledIds))
    : [];
  const defaultScope: UsageScope = {
    key: "default",
    kind: "default",
    accountId: null,
    accountLabel: null,
    authPath: null,
  };

  const providers: UsageProviderInstance[] = [];
  for (const definition of definitions) {
    if (definition.kind === "shared") {
      providers.push(createProviderInstance(definition, defaultScope));
      continue;
    }

    if (requestScope.kind === "default") {
      providers.push(createProviderInstance(definition, defaultScope));
      continue;
    }

    const matchingAccounts = accounts.filter((account) =>
      accountHasProvider(account, definition.id),
    );
    if (matchingAccounts.length === 0) {
      if (requestScope.kind === "all") {
        providers.push(createProviderInstance(definition, defaultScope));
      }
      continue;
    }
    if (!agentDir) throw new Error("アカウント認証ディレクトリを解決できません");
    for (const account of matchingAccounts) {
      const scope: UsageScope = {
        key: `account:${account.id}`,
        kind: "account",
        accountId: account.id,
        accountLabel: account.label,
        authPath: accountAuthPath(account.id, agentDir),
      };
      providers.push(createProviderInstance(definition, scope));
    }
  }

  const accountId = requestScope.kind === "account" ? requestScope.accountId : null;
  const scope: ExportScope = { kind: requestScope.kind, accountId };
  const roster = rosterKey(summaries);
  const cacheKey =
    requestScope.kind === "all"
      ? `all:${enabledIds.join(",")}:${roster}`
      : requestScope.kind === "account"
        ? `account:${accountId}:${enabledIds.join(",")}:${roster}`
        : `default:${enabledIds.join(",")}`;

  return {
    requestScope,
    enabledIds,
    providers,
    cacheKey,
    metadata: {
      scope,
      accounts: summaries,
      providerOrder: enabledIds,
    },
  };
}

function resultMetadata(provider: UsageProviderInstance) {
  return {
    id: provider.id,
    name: provider.name,
    instanceId: provider.instanceId,
    accountId: provider.accountId,
    accountLabel: provider.accountLabel,
  };
}

function resultFromCache(
  provider: UsageProviderInstance,
  cached: NonNullable<ReturnType<typeof shouldSkipProviderFetch>>,
): ProviderFetchResult {
  const metadata = resultMetadata(provider);
  if (cached.kind === "ok" && cached.snapshot) {
    return {
      ...metadata,
      configured: true,
      snapshot: cached.snapshot,
      error: null,
    };
  }

  // Prefer last-good during rate-limit / soft errors so the UI stays useful.
  if (cached.lastGood) {
    return {
      ...metadata,
      configured: true,
      snapshot: { ...cached.lastGood, isStale: true },
      error: cached.error,
    };
  }

  return {
    ...metadata,
    configured: true,
    snapshot: null,
    error: cached.error,
  };
}

async function fetchOne(
  provider: UsageProviderInstance,
  forceRefresh: boolean,
  signal?: AbortSignal,
): Promise<ProviderFetchResult> {
  const metadata = resultMetadata(provider);
  const configured = provider.isConfigured();
  if (!configured) {
    return { ...metadata, configured: false, snapshot: null, error: null };
  }

  const cached = shouldSkipProviderFetch(provider.instanceId, forceRefresh);
  if (cached) return resultFromCache(provider, cached);

  try {
    const snapshot = await provider.fetch(signal);
    setProviderCacheOk(provider.instanceId, snapshot);
    return {
      ...metadata,
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
    setProviderCacheError(provider.instanceId, message, rateLimited);

    const lastGood = peekLastGood(provider.instanceId);
    if (lastGood) {
      return {
        ...metadata,
        configured: true,
        snapshot: { ...lastGood, isStale: true },
        error: message,
      };
    }

    return {
      ...metadata,
      configured: true,
      snapshot: null,
      error: message,
    };
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await fn(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

function assembleFromResults(
  results: ProviderFetchResult[],
  metadata: FetchPlan["metadata"],
): { usage: CodexBarUsage; anyConfigured: boolean } {
  const entries: ExportEntry[] = [];
  let anyConfigured = false;

  for (const result of results) {
    if (!result.configured) continue;
    anyConfigured = true;
    const entry = buildEntry(result.id, result.snapshot, result.error, {
      instanceId: result.instanceId,
      accountId: result.accountId,
      accountLabel: result.accountLabel,
    });
    if (entry) entries.push(entry);
  }

  return {
    usage: buildUsageFromEntries(entries, metadata),
    anyConfigured,
  };
}

async function fetchNativeUsageUncached(
  plan: FetchPlan,
  options: FetchUsageOptions,
): Promise<CodexBarUsage> {
  const { forceRefresh = false, signal } = options;
  const results = await mapWithConcurrency(
    plan.providers,
    MAX_CONCURRENT_FETCHES,
    (provider) => fetchOne(provider, forceRefresh, signal),
  );
  const { usage, anyConfigured } = assembleFromResults(results, plan.metadata);

  const hasAccountRows = plan.metadata.accounts.some((account) => account.providers.length > 0);
  if (anyConfigured || hasAccountRows) {
    setCachedUsage(usage, Date.now(), plan.cacheKey);
    return usage;
  }

  return emptyUsage(
    "利用状況を取得できるプロバイダーが設定されていません（Codex / Claude / Cursor 等にサインインするか、API キーを設定してください）",
  );
}

const inflight = new Map<string, Promise<CodexBarUsage>>();

/**
 * Fetch usage: scoped aggregate cache → native parallel fetches
 * (scope-specific provider cache).
 */
export async function fetchNativeUsage(
  options: FetchUsageOptions = {},
): Promise<CodexBarUsage> {
  const forceRefresh = options.forceRefresh === true;
  const plan = await buildFetchPlan(options.scope ?? { kind: "all" });

  if (!forceRefresh) {
    const cached = getCachedUsageForKey(plan.cacheKey);
    if (cached) return cached;
  } else {
    clearCachedUsage(plan.cacheKey);
  }

  const existing = inflight.get(plan.cacheKey);
  if (existing) return existing;

  const promise = fetchNativeUsageUncached(plan, options).finally(() => {
    if (inflight.get(plan.cacheKey) === promise) inflight.delete(plan.cacheKey);
  });
  inflight.set(plan.cacheKey, promise);
  return promise;
}
