import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";
import { hasLastGoodUsage, type CodexBarProvider } from "@/lib/codexbar";
import type { AccountProviderId } from "@/lib/accounts";

export type AccountRoutingMode = "integrated" | "separate";

export const ACCOUNT_ROUTING_PROVIDER_IDS: readonly AccountProviderId[] = [
  "openai-codex",
  "anthropic",
  "ollama-cloud",
  "openrouter",
  "commandcode",
  "cursor",
  "opencode",
  "opencode-go",
];

export function isAccountRoutingProvider(
  providerId: string,
): providerId is AccountProviderId {
  return (ACCOUNT_ROUTING_PROVIDER_IDS as readonly string[]).includes(
    providerId,
  );
}

export type ProviderRoutingState = {
  version: 1;
  modes: Partial<Record<AccountProviderId, AccountRoutingMode>>;
};

function emptyState(): ProviderRoutingState {
  return { version: 1, modes: {} };
}

export function providerRoutingPath(dir = dataDir()): string {
  return join(dir, "provider-routing.json");
}

export function readProviderRouting(
  path = providerRoutingPath(),
): ProviderRoutingState {
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ProviderRoutingState>;
    if (
      parsed.version !== 1 ||
      !parsed.modes ||
      typeof parsed.modes !== "object"
    ) {
      return emptyState();
    }
    const modes: ProviderRoutingState["modes"] = {};
    for (const providerId of ACCOUNT_ROUTING_PROVIDER_IDS) {
      const mode = parsed.modes[providerId];
      if (mode === "integrated" || mode === "separate")
        modes[providerId] = mode;
    }
    return { version: 1, modes };
  } catch {
    return emptyState();
  }
}

export function accountRoutingMode(
  providerId: string,
  state = readProviderRouting(),
): AccountRoutingMode {
  return isAccountRoutingProvider(providerId) &&
    state.modes[providerId] === "integrated"
    ? "integrated"
    : "separate";
}

function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(
    dir,
    `.${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
    throw error;
  }
}

export function writeProviderRouting(
  state: ProviderRoutingState,
  path = providerRoutingPath(),
): void {
  atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

let writeQueue: Promise<unknown> = Promise.resolve();

export function setAccountRoutingMode(
  providerId: AccountProviderId,
  mode: AccountRoutingMode,
  path = providerRoutingPath(),
): Promise<void> {
  const run = writeQueue.then(() => {
    const state = readProviderRouting(path);
    state.modes[providerId] = mode;
    writeProviderRouting(state, path);
  });
  writeQueue = run.catch(() => undefined);
  return run;
}

export type RoutingUsage = Pick<
  CodexBarProvider,
  | "usedPercent"
  | "maxed"
  | "stale"
  | "resetsAt"
  | "error"
  | "windows"
  | "credits"
>;

export type RoutingCandidate<T = unknown> = {
  accountId: string;
  accountIndex: number;
  value: T;
  usage?: RoutingUsage | null;
  workingTaskCount: number;
};

export type RankedRoutingCandidate<T = unknown> = RoutingCandidate<T> & {
  tier: 0 | 1 | 2 | 3;
};

function resetTime(usage: RoutingUsage | null | undefined): number | null {
  if (!usage?.resetsAt) return null;
  const value = Date.parse(usage.resetsAt);
  return Number.isFinite(value) ? value : null;
}

function usageIsKnown(
  usage: RoutingUsage | null | undefined,
): usage is RoutingUsage {
  return Boolean(
    usage && usage.usedPercent !== null && hasLastGoodUsage(usage),
  );
}

function candidateTier(
  candidate: RoutingCandidate,
  nowMs: number,
): RankedRoutingCandidate["tier"] {
  const usage = candidate.usage;
  if (!usage) return 2;
  const reset = resetTime(usage);
  const maxedExpired = usage.maxed && reset !== null && reset <= nowMs;
  if (usage.maxed && !usage.stale && !maxedExpired) return 3;
  if (usage.maxed && usage.stale) return 2;
  if (!usageIsKnown(usage)) return 2;
  return usage.stale ? 1 : 0;
}

export function rankRoutingCandidates<T>(
  candidates: readonly RoutingCandidate<T>[],
  nowMs = Date.now(),
): RankedRoutingCandidate<T>[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      tier: candidateTier(candidate, nowMs),
    }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier <= 1) {
        const usageDiff =
          (a.usage?.usedPercent ?? Number.POSITIVE_INFINITY) -
          (b.usage?.usedPercent ?? Number.POSITIVE_INFINITY);
        if (usageDiff !== 0) return usageDiff;
      }
      if (a.tier === 3) {
        const aReset = resetTime(a.usage) ?? Number.POSITIVE_INFINITY;
        const bReset = resetTime(b.usage) ?? Number.POSITIVE_INFINITY;
        if (aReset !== bReset) return aReset - bReset;
      }
      if (a.workingTaskCount !== b.workingTaskCount) {
        return a.workingTaskCount - b.workingTaskCount;
      }
      return (
        a.accountIndex - b.accountIndex ||
        a.accountId.localeCompare(b.accountId, "en")
      );
    });
}

export type RoutingDecision<T = unknown> = {
  candidate?: RankedRoutingCandidate<T>;
  allMaxed: boolean;
  resetAt: string | null;
  ranked: RankedRoutingCandidate<T>[];
};

export function chooseRoutingCandidate<T>(
  candidates: readonly RoutingCandidate<T>[],
  nowMs = Date.now(),
): RoutingDecision<T> {
  const ranked = rankRoutingCandidates(candidates, nowMs);
  const candidate = ranked.find((entry) => entry.tier < 3);
  if (candidate) return { candidate, allMaxed: false, resetAt: null, ranked };
  const reset =
    ranked
      .map((entry) => entry.usage?.resetsAt)
      .filter((value): value is string => {
        if (!value) return false;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed > nowMs;
      })
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return {
    allMaxed: ranked.length > 0 && ranked.every((entry) => entry.tier === 3),
    resetAt: reset,
    ranked,
  };
}

/** Test helper: reset the process-local settings write queue. */
export function __resetProviderRoutingQueueForTests(): void {
  writeQueue = Promise.resolve();
}
