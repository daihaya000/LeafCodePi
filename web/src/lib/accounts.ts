import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./paths";
import { invalidateCachedUsage } from "./codexbar/cache";
import { clearProviderCache } from "./codexbar/provider-cache";
import { isGoalLoopLiveStatus, readGoalLoopState } from "./pi/goal-loop-state";
import { getTaskHangWatch } from "./pi/hang-watchdog";
import { listTasks } from "./store";
import { hasActiveTaskLease } from "./task-runtime-lease";

/**
 * マルチアカウント対応の model 層（docs/plans/multi-account.md Phase 1）。
 *
 * アカウント = 独立した Pi 認証ストレージ（~/.pi/agent/accounts/<id>/auth.json）。
 * アカウントの一覧・メタデータは dataDir 配下の accounts.json に保存する
 * （store.json は閉じた型のため触らない）。
 */

export type AccountProviderId =
  | "openai-codex"
  | "anthropic"
  | "ollama-cloud"
  | "openrouter"
  | "commandcode"
  | "cursor"
  | "opencode"
  | "opencode-go";

export const ACCOUNT_PROVIDER_IDS: readonly AccountProviderId[] = [
  "openai-codex",
  "anthropic",
  "ollama-cloud",
  "openrouter",
  "commandcode",
  "cursor",
  "opencode",
  "opencode-go",
];

/**
 * アカウントが必須で、既定認証（~/.pi/agent/auth.json）からはモデルを出さない
 * プロバイダー。マルチアカウント対応プロバイダーはすべて対象にする。
 */
export const ACCOUNT_ONLY_PROVIDER_IDS: readonly AccountProviderId[] =
  ACCOUNT_PROVIDER_IDS;

export function isAccountProviderId(
  providerId: string,
): providerId is AccountProviderId {
  return (ACCOUNT_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export function isAccountOnlyProvider(
  providerId: string,
): providerId is AccountProviderId {
  return (ACCOUNT_ONLY_PROVIDER_IDS as readonly string[]).includes(providerId);
}

export type AccountRecord = {
  id: string;
  label: string;
  /** モデル選択・ルーティングで使用するアカウントか。 */
  enabled: boolean;
  /** このアカウントでログイン可能なプロバイダー（作成時に確定、変更不可）。 */
  providers: AccountProviderId[];
  note?: string;
  createdAt: string;
  updatedAt: string;
};

type AccountsFile = {
  version: 1;
  accounts: AccountRecord[];
};

const LABEL_MAX = 100;
const NOTE_MAX = 500;

let cachedAgentDir: string | null = null;

/**
 * Pi の agentDir（既定 ~/.pi/agent）。SDK の getAgentDir を遅延解決してキャッシュする
 * （harness.loadPi と同じく静的 import を避けるため）。
 */
export async function resolvePiAgentDir(): Promise<string> {
  if (!cachedAgentDir) {
    const pi = await import("@earendil-works/pi-coding-agent");
    cachedAgentDir = pi.getAgentDir();
  }
  return cachedAgentDir;
}

/** @internal テスト用。agentDir キャッシュをリセットする。 */
export function __resetPiAgentDirCacheForTests(): void {
  cachedAgentDir = null;
}

/** アカウント認証ディレクトリ（~/.pi/agent/accounts/<id>/）。 */
export function accountDir(id: string, agentDir: string): string {
  return join(agentDir, "accounts", id);
}

/** アカウントの認証ストレージ（Pi AuthStorage 形式の auth.json）。 */
export function accountAuthPath(id: string, agentDir: string): string {
  return join(accountDir(id, agentDir), "auth.json");
}

/** アカウント専用のモデルカタログキャッシュ（使い捨て。カスタム models.json は共有のまま）。 */
export function accountModelsStorePath(id: string, agentDir: string): string {
  return join(accountDir(id, agentDir), "models-store.json");
}

function isStoredCredential(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") {
    return (
      (credential.key === undefined || typeof credential.key === "string") &&
      (credential.env === undefined ||
        (typeof credential.env === "object" &&
          credential.env !== null &&
          !Array.isArray(credential.env) &&
          Object.values(credential.env).every((entry) => typeof entry === "string")))
    );
  }
  return (
    credential.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string" &&
    typeof credential.expires === "number" &&
    Number.isFinite(credential.expires)
  );
}

/** アカウントの auth.json に保存済みのサブスクプロバイダー。SDK を介さない軽量ファイル読み。
 *  読めない（未ログイン・破損・書込中）場合は空配列。 */
export function accountStoredProviders(
  id: string,
  agentDir: string,
): AccountProviderId[] {
  const entries = readAccountAuthEntries(id, agentDir);
  if (!entries) return [];
  return ACCOUNT_PROVIDER_IDS.filter(
    (provider) => storedCredentialKind(entries[provider]) !== null,
  );
}

/** 保存済み資格情報の種類（サブスク OAuth / API キー）。 */
export type AccountCredentialKind = "oauth" | "api_key";

/** auth.json の中身（provider ごとに 1 エントリだけ持つ）。 */
function readAccountAuthEntries(
  id: string,
  agentDir: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(
      readFileSync(accountAuthPath(id, agentDir), "utf8"),
    ) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function storedCredentialKind(value: unknown): AccountCredentialKind | null {
  if (!isStoredCredential(value)) return null;
  return (value as { type?: unknown }).type === "api_key" ? "api_key" : "oauth";
}

/**
 * 保存済み資格情報の種類をプロバイダー別に返す。
 * UI はこれで「この口座はサブスクか API キーか」を判断する
 * （例: Anthropic の Console cookie は API キー口座にだけ必要）。
 */
export function accountCredentialKinds(
  id: string,
  agentDir: string,
): Partial<Record<AccountProviderId, AccountCredentialKind>> {
  const entries = readAccountAuthEntries(id, agentDir);
  const kinds: Partial<Record<AccountProviderId, AccountCredentialKind>> = {};
  if (!entries) return kinds;
  for (const provider of ACCOUNT_PROVIDER_IDS) {
    const kind = storedCredentialKind(entries[provider]);
    if (kind) kinds[provider] = kind;
  }
  return kinds;
}

function accountsPath(): string {
  return join(dataDir(), "accounts.json");
}

function emptyAccountsFile(): AccountsFile {
  return { version: 1, accounts: [] };
}

function readAccountsFile(): AccountsFile {
  try {
    const parsed = JSON.parse(
      readFileSync(accountsPath(), "utf8"),
    ) as AccountsFile | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      return emptyAccountsFile();
    }
    // enabled が無い旧データは従来どおり使用可能として移行する。
    return {
      version: 1,
      accounts: parsed.accounts.map((account) => ({
        ...account,
        enabled: account.enabled !== false,
      })),
    };
  } catch {
    return emptyAccountsFile();
  }
}

function writeAccountsFile(file: AccountsFile): void {
  const path = accountsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(): Error {
  return Object.assign(new Error("アカウントが見つかりません"), {
    status: 404,
  });
}

function validateLabel(label: unknown): string {
  if (typeof label !== "string")
    throw badRequest("label は文字列で指定してください");
  const trimmed = label.trim();
  if (!trimmed) throw badRequest("label は必須です");
  if (trimmed.length > LABEL_MAX) {
    throw badRequest(`label は ${LABEL_MAX} 文字以内にしてください`);
  }
  return trimmed;
}

function validateNote(note: unknown): string | undefined {
  if (note === undefined || note === null) return undefined;
  if (typeof note !== "string")
    throw badRequest("note は文字列で指定してください");
  const trimmed = note.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > NOTE_MAX) {
    throw badRequest(`note は ${NOTE_MAX} 文字以内にしてください`);
  }
  return trimmed;
}

/** アカウントに紐づくプロバイダーだけを、そのアカウントのモデル枠へ出す。 */
export function accountHasProvider(
  account: Pick<AccountRecord, "providers">,
  providerId: string,
): boolean {
  return (
    isAccountProviderId(providerId) &&
    Array.isArray(account.providers) &&
    account.providers.includes(providerId)
  );
}

/** 旧 accounts.json では enabled が無いため、false 以外は使用可能とする。 */
export function isAccountEnabled(
  account: Pick<AccountRecord, "enabled"> | { enabled?: boolean },
): boolean {
  return account.enabled !== false;
}

function normalizeProviders(input: unknown): AccountProviderId[] {
  if (!Array.isArray(input))
    throw badRequest("providers は配列で指定してください");
  const set = new Set<unknown>(input);
  for (const item of set) {
    if (typeof item !== "string" || !isAccountProviderId(item)) {
      throw badRequest(`対応していないプロバイダー: ${String(item)}`);
    }
  }
  if (set.size === 0) throw badRequest("providers は空にできません");
  // 表示順を固定するため既定順で返す
  return ACCOUNT_PROVIDER_IDS.filter((provider) => set.has(provider));
}

export function listAccounts(): AccountRecord[] {
  return readAccountsFile().accounts.map((account) => ({ ...account }));
}

/** アカウント一覧の表示順を保存する。入力は現在の全アカウントを一度ずつ含む必要がある。 */
export function reorderAccounts(input: unknown): AccountRecord[] {
  if (
    !Array.isArray(input) ||
    !input.every((id): id is string => typeof id === "string")
  ) {
    throw badRequest("accountOrder はアカウントIDの配列で指定してください");
  }

  const file = readAccountsFile();
  const currentIds = new Set(file.accounts.map((account) => account.id));
  const nextIds = new Set(input);
  if (
    nextIds.size !== input.length ||
    nextIds.size !== currentIds.size ||
    input.some((id) => !currentIds.has(id))
  ) {
    throw badRequest("accountOrder は現在の全アカウントを一度ずつ指定してください");
  }

  const currentOrder = file.accounts.map((account) => account.id);
  if (input.every((id, index) => id === currentOrder[index])) {
    return file.accounts.map((account) => ({ ...account }));
  }

  const accountsById = new Map(
    file.accounts.map((account) => [account.id, account]),
  );
  file.accounts = input.map((id) => accountsById.get(id)!);
  writeAccountsFile(file);
  invalidateCachedUsage();
  return file.accounts.map((account) => ({ ...account }));
}

export function getAccount(id: string): AccountRecord | undefined {
  const found = readAccountsFile().accounts.find(
    (account) => account.id === id,
  );
  return found ? { ...found } : undefined;
}

export function createAccount(input: {
  label: unknown;
  providers: unknown;
  note?: unknown;
}): AccountRecord {
  const note = validateNote(input.note);
  const now = new Date().toISOString();
  const record: AccountRecord = {
    id: randomUUID(),
    label: validateLabel(input.label),
    enabled: true,
    providers: normalizeProviders(input.providers),
    ...(note ? { note } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const file = readAccountsFile();
  file.accounts.push(record);
  writeAccountsFile(file);
  invalidateCachedUsage();
  return { ...record };
}

/**
 * 実行中タスク / live Goal Loop / ランタイム lease / hang 監視から参照されている
 * アカウントは削除も一時停止も拒否する（provider fallback 中や hang abort→resume
 * の隙間は status が idle でも lease / hang watch が残る）。
 */
function assertAccountIdleForDisable(id: string, action: "delete" | "pause"): void {
  const verb = action === "delete" ? "削除" : "一時停止";
  for (const task of listTasks(false, "all")) {
    if (task.accountId !== id) continue;
    if (task.status === "working" || hasActiveTaskLease(task.id)) {
      throw Object.assign(
        new Error(`このアカウントで実行中のタスクがあるため${verb}できません`),
        { status: 409 },
      );
    }
    // Hang watchdog aborts to idle before resumePrompt; pausing here lets the
    // auto-resume re-enter a disabled account.
    if (getTaskHangWatch(task.id)) {
      throw Object.assign(
        new Error(`このアカウントでハング復旧中のタスクがあるため${verb}できません`),
        { status: 409 },
      );
    }
    const loop = readGoalLoopState(task.directory, task.sessionId);
    if (loop && isGoalLoopLiveStatus(loop.status)) {
      throw Object.assign(
        new Error(`このアカウントで Goal Loop が動作中のため${verb}できません`),
        { status: 409 },
      );
    }
  }
}

export function patchAccount(
  id: string,
  patch: { label?: unknown; note?: unknown; enabled?: unknown },
): AccountRecord {
  const file = readAccountsFile();
  const record = file.accounts.find((account) => account.id === id);
  if (!record) throw notFound();
  if (patch.label !== undefined) record.label = validateLabel(patch.label);
  if ("note" in patch) {
    const note = validateNote(patch.note);
    if (note) record.note = note;
    else delete record.note;
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw badRequest("enabled は真偽値で指定してください");
    }
    if (patch.enabled === false && record.enabled !== false) {
      assertAccountIdleForDisable(id, "pause");
    }
    record.enabled = patch.enabled;
  }
  record.updatedAt = new Date().toISOString();
  writeAccountsFile(file);
  invalidateCachedUsage();
  return { ...record };
}

/**
 * アカウントを削除する。実行中タスクから参照されている間は拒否（409）。
 * 認証ファイル（~/.pi/agent/accounts/<id>/）は意図的に残す
 * （実行中セッションが認証を読み続けられるようにするため。再作成時も同じパスを使う）。
 */
export function deleteAccount(id: string): void {
  // code / bot 双方。Goal Loop は idle でもループが生きていることがある。
  assertAccountIdleForDisable(id, "delete");
  const file = readAccountsFile();
  const index = file.accounts.findIndex((account) => account.id === id);
  if (index === -1) throw notFound();
  file.accounts.splice(index, 1);
  writeAccountsFile(file);
  for (const provider of ACCOUNT_PROVIDER_IDS) {
    clearProviderCache(`account:${id}:${provider}`);
  }
  invalidateCachedUsage();
}
