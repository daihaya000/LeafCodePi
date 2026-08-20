/**
 * Cursor usage via cursor.com/api/usage-summary.
 * Token: auth.json first, then state.vscdb via node:sqlite (Node 22+).
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ProviderError,
  type IUsageProvider,
  type RateWindow,
  type UsageSnapshot,
} from "@/lib/codexbar/types";
import {
  asRecord,
  clamp,
  decodeJwtPayload,
  fetchText,
  flexibleNumber,
} from "@/lib/codexbar/utils";

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const AUTH_ME_URL = "https://cursor.com/api/auth/me";

function appData(): string {
  return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
}

function stateDbPath(): string {
  return join(appData(), "Cursor", "User", "globalStorage", "state.vscdb");
}

function authJsonPath(): string {
  return join(appData(), "Cursor", "auth.json");
}

function prettyPlan(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  switch (raw.toLowerCase()) {
    case "pro":
      return "Pro";
    case "pro_plus":
    case "proplus":
    case "pro+":
      return "Pro+";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "hobby":
    case "free":
      return "Hobby";
    case "ultra":
      return "Ultra";
    default:
      return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
}

function tokenIssuedAt(accessToken: string): number {
  const root = decodeJwtPayload(accessToken);
  if (!root) return 0;
  if (typeof root.time === "number") return root.time;
  if (typeof root.time === "string") {
    const n = Number(root.time);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof root.exp === "number") return root.exp;
  return 0;
}

function tryLoadAccessTokenFromAuthJson(): string | null {
  try {
    const path = authJsonPath();
    if (!existsSync(path)) return null;
    const root = asRecord(JSON.parse(readFileSync(path, "utf8")));
    const at = root?.accessToken;
    return typeof at === "string" && at.trim() ? at : null;
  } catch {
    return null;
  }
}

function readItemFromDb(dbPath: string, key: string): string | null {
  // node:sqlite (Node 22+). Dynamic require keeps bundlers from failing on older Node.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      opts?: { readOnly?: boolean },
    ) => {
      prepare: (sql: string) => {
        get: (...params: unknown[]) => { value?: unknown } | undefined;
      };
      close: () => void;
    };
  };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
      .get(key);
    if (!row) return null;
    const v = row.value;
    if (typeof v === "string" && v.trim()) return v;
    if (Buffer.isBuffer(v)) return v.toString("utf8");
    return null;
  } finally {
    db.close();
  }
}

function readItemFromDbCopy(dbPath: string, key: string): string | null {
  const tmp = join(tmpdir(), `leafcode-cursor-${randomUUID()}.vscdb`);
  try {
    copyFileSync(dbPath, tmp);
    for (const suffix of ["-wal", "-shm"]) {
      const side = dbPath + suffix;
      if (existsSync(side)) {
        try {
          copyFileSync(side, tmp + suffix);
        } catch {
          /* ignore */
        }
      }
    }
    return readItemFromDb(tmp, key);
  } catch {
    return null;
  } finally {
    for (const p of [tmp, tmp + "-wal", tmp + "-shm"]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function tryLoadAccessTokenFromStateDb(): string | null {
  const path = stateDbPath();
  if (!existsSync(path)) return null;
  try {
    return readItemFromDb(path, "cursorAuth/accessToken");
  } catch {
    return readItemFromDbCopy(path, "cursorAuth/accessToken");
  }
}

function readItem(key: string): string | null {
  const path = stateDbPath();
  if (!existsSync(path)) return null;
  try {
    return readItemFromDb(path, key);
  } catch {
    return readItemFromDbCopy(path, key);
  }
}

function loadCandidateAccessTokens(): string[] {
  const tokens: string[] = [];
  const add = (t: string | null) => {
    if (t?.trim() && !tokens.includes(t)) tokens.push(t);
  };
  add(tryLoadAccessTokenFromStateDb());
  add(tryLoadAccessTokenFromAuthJson());
  return tokens.sort((a, b) => tokenIssuedAt(b) - tokenIssuedAt(a));
}

function extractUserId(accessToken: string): string {
  const root = decodeJwtPayload(accessToken);
  if (!root || typeof root.sub !== "string") {
    throw new Error("missing sub");
  }
  const parts = root.sub.split("|").filter(Boolean);
  const userId = parts[parts.length - 1];
  if (!userId || /[^a-zA-Z0-9._-]/.test(userId)) {
    throw new Error("invalid user id");
  }
  if (typeof root.exp === "number") {
    if (root.exp * 1000 <= Date.now() + 60_000) {
      throw new Error("token expired");
    }
  }
  return userId;
}

function parseIso(root: Record<string, unknown>, key: string): Date | null {
  const v = root[key];
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

function flexField(obj: Record<string, unknown> | null, key: string): number | null {
  if (!obj) return null;
  return flexibleNumber(obj[key]);
}

/** Exported for unit tests. */
export function parseCursorUsageSummary(
  root: Record<string, unknown>,
  email: string | null = null,
): UsageSnapshot {
  const cycleStart = parseIso(root, "billingCycleStart");
  const cycleEnd = parseIso(root, "billingCycleEnd");
  let durationMs: number | null = null;
  if (cycleStart && cycleEnd && cycleEnd > cycleStart) {
    durationMs = cycleEnd.getTime() - cycleStart.getTime();
  }

  const membership =
    typeof root.membershipType === "string"
      ? prettyPlan(root.membershipType)
      : prettyPlan(readItem("cursorAuth/stripeMembershipType"));

  const individual = asRecord(root.individualUsage);
  const team = asRecord(root.teamUsage);
  const plan = asRecord(individual?.plan);
  let onDemand = asRecord(individual?.onDemand);
  const overall = asRecord(individual?.overall);
  const pooled = asRecord(team?.pooled);
  if (!onDemand) onDemand = asRecord(team?.onDemand);

  const autoPct = flexField(plan, "autoPercentUsed");
  const apiPct = flexField(plan, "apiPercentUsed");
  const totalPct = flexField(plan, "totalPercentUsed");
  const planUsedRaw = flexField(plan, "used") ?? 0;
  const planLimitRaw = flexField(plan, "limit") ?? 0;
  const overallUsed = flexField(overall, "used");
  const overallLimit = flexField(overall, "limit");
  const pooledUsed = flexField(pooled, "used");
  const pooledLimit = flexField(pooled, "limit");

  let planPercent: number;
  if (totalPct !== null) planPercent = clamp(totalPct, 0, 100);
  else if (autoPct !== null && apiPct !== null)
    planPercent = clamp((autoPct + apiPct) / 2, 0, 100);
  else if (apiPct !== null) planPercent = clamp(apiPct, 0, 100);
  else if (autoPct !== null) planPercent = clamp(autoPct, 0, 100);
  else if (planLimitRaw > 0)
    planPercent = clamp((planUsedRaw / planLimitRaw) * 100, 0, 100);
  else if (overallUsed !== null && overallLimit !== null && overallLimit > 0)
    planPercent = clamp((overallUsed / overallLimit) * 100, 0, 100);
  else if (pooledUsed !== null && pooledLimit !== null && pooledLimit > 0)
    planPercent = clamp((pooledUsed / pooledLimit) * 100, 0, 100);
  else planPercent = 0;

  const windows: RateWindow[] = [
    {
      id: "cursor-plan",
      title: "プラン",
      usedPercent: planPercent,
      resetsAt: cycleEnd,
      windowDurationMs: durationMs,
      countsTowardLimit: true,
    },
  ];

  if (autoPct !== null) {
    windows.push({
      id: "cursor-auto",
      title: "Auto",
      usedPercent: clamp(autoPct, 0, 100),
      resetsAt: cycleEnd,
      windowDurationMs: durationMs,
      countsTowardLimit: false,
    });
  }
  if (apiPct !== null && apiPct > 0) {
    windows.push({
      id: "cursor-api",
      title: "API",
      usedPercent: clamp(apiPct, 0, 100),
      resetsAt: cycleEnd,
      windowDurationMs: durationMs,
      countsTowardLimit: false,
    });
  }

  if (onDemand) {
    const usedCents = flexField(onDemand, "used") ?? 0;
    const limitCents = flexField(onDemand, "limit");
    if (limitCents !== null && limitCents > 0) {
      const usedUsd = usedCents / 100;
      const limitUsd = limitCents / 100;
      windows.push({
        id: "cursor-ondemand",
        title: "オンデマンド",
        usedPercent: clamp((usedUsd / limitUsd) * 100, 0, 100),
        resetsAt: cycleEnd,
        windowDurationMs: durationMs,
        countsTowardLimit: false,
      });
    }
  }

  return {
    providerId: "cursor",
    providerName: "Cursor",
    plan: membership,
    accountEmail: email,
    windows,
    creditsEnabled: false,
    creditsTitle: null,
    creditsUsed: null,
    creditsLimit: null,
    creditsBalance: null,
    creditsLabel: null,
    sourceLabel: "Cursor.app + usage-summary",
    updatedAt: new Date(),
    isStale: false,
  };
}

export const cursorProvider: IUsageProvider = {
  id: "cursor",
  name: "Cursor",
  isConfigured() {
    try {
      return loadCandidateAccessTokens().length > 0;
    } catch {
      return existsSync(stateDbPath()) || existsSync(authJsonPath());
    }
  },
  async fetch(signal) {
    const accessTokens = loadCandidateAccessTokens();
    if (accessTokens.length === 0) {
      throw new ProviderError(
        "Cursor の認証情報が見つかりません。この PC で Cursor アプリにサインインしてください。",
      );
    }

    let cookie: string | null = null;
    let summaryBody: string | null = null;
    let sawAuthRejection = false;

    for (const accessToken of accessTokens) {
      let userId: string;
      try {
        userId = extractUserId(accessToken);
      } catch {
        continue;
      }
      const candidateCookie = `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
      const { status, body, ok } = await fetchText(USAGE_SUMMARY_URL, {
        headers: {
          Accept: "application/json",
          Cookie: candidateCookie,
          "User-Agent": "CodexBar",
        },
        signal,
      });
      if (status === 401 || status === 403) {
        sawAuthRejection = true;
        continue;
      }
      if (!ok) throw new ProviderError(`Cursor API エラー ${status}。`);
      cookie = candidateCookie;
      summaryBody = body;
      break;
    }

    if (!summaryBody || !cookie) {
      if (sawAuthRejection) {
        throw new ProviderError(
          "Cursor のセッションが拒否されました。Cursor アプリに再サインインしてください。",
        );
      }
      throw new ProviderError(
        "Cursor のアクセストークンが無効か期限切れです。Cursor に再サインインしてください。",
      );
    }

    let email: string | null = null;
    try {
      const me = await fetchText(AUTH_ME_URL, {
        headers: {
          Accept: "application/json",
          Cookie: cookie,
          "User-Agent": "CodexBar",
        },
        signal,
      });
      if (me.ok) {
        const root = asRecord(JSON.parse(me.body));
        if (typeof root?.email === "string") email = root.email;
      }
    } catch {
      /* optional */
    }
    email ??= readItem("cursorAuth/cachedEmail");

    const root = asRecord(JSON.parse(summaryBody));
    if (!root) throw new ProviderError("Cursor の応答形式が不正です。");
    return parseCursorUsageSummary(root, email);
  },
};
