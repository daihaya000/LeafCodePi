import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./paths";
import { listTasks } from "./store";

/**
 * マルチアカウント対応の model 層（docs/plans/multi-account.md Phase 1）。
 *
 * アカウント = 独立した Pi 認証ストレージ（~/.pi/agent/accounts/<id>/auth.json）。
 * アカウントの一覧・メタデータは dataDir 配下の accounts.json に保存する
 * （store.json は閉じた型のため触らない）。
 */

export type AccountProviderId = "openai-codex" | "anthropic";

export const ACCOUNT_PROVIDER_IDS: readonly AccountProviderId[] = ["openai-codex", "anthropic"];

export type AccountRecord = {
  id: string;
  label: string;
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

/** アカウントの auth.json に保存済みのサブスクプロバイダー。SDK を介さない軽量ファイル読み。
 *  読めない（未ログイン・破損・書込中）場合は空配列。 */
export function accountStoredProviders(id: string, agentDir: string): AccountProviderId[] {
  try {
    const parsed = JSON.parse(readFileSync(accountAuthPath(id, agentDir), "utf8")) as
      | Record<string, unknown>
      | null;
    if (!parsed || typeof parsed !== "object") return [];
    return ACCOUNT_PROVIDER_IDS.filter((provider) => provider in parsed);
  } catch {
    return [];
  }
}

function accountsPath(): string {
  return join(dataDir(), "accounts.json");
}

function emptyAccountsFile(): AccountsFile {
  return { version: 1, accounts: [] };
}

function readAccountsFile(): AccountsFile {
  try {
    const parsed = JSON.parse(readFileSync(accountsPath(), "utf8")) as AccountsFile | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      return emptyAccountsFile();
    }
    return parsed;
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
  return Object.assign(new Error("アカウントが見つかりません"), { status: 404 });
}

function validateLabel(label: unknown): string {
  if (typeof label !== "string") throw badRequest("label は文字列で指定してください");
  const trimmed = label.trim();
  if (!trimmed) throw badRequest("label は必須です");
  if (trimmed.length > LABEL_MAX) {
    throw badRequest(`label は ${LABEL_MAX} 文字以内にしてください`);
  }
  return trimmed;
}

function validateNote(note: unknown): string | undefined {
  if (note === undefined || note === null) return undefined;
  if (typeof note !== "string") throw badRequest("note は文字列で指定してください");
  const trimmed = note.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > NOTE_MAX) {
    throw badRequest(`note は ${NOTE_MAX} 文字以内にしてください`);
  }
  return trimmed;
}

function normalizeProviders(input: unknown): AccountProviderId[] {
  if (!Array.isArray(input)) throw badRequest("providers は配列で指定してください");
  const set = new Set<unknown>(input);
  for (const item of set) {
    if (item !== "openai-codex" && item !== "anthropic") {
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

export function getAccount(id: string): AccountRecord | undefined {
  const found = readAccountsFile().accounts.find((account) => account.id === id);
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
    providers: normalizeProviders(input.providers),
    ...(note ? { note } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const file = readAccountsFile();
  file.accounts.push(record);
  writeAccountsFile(file);
  return { ...record };
}

export function patchAccount(
  id: string,
  patch: { label?: unknown; note?: unknown },
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
  record.updatedAt = new Date().toISOString();
  writeAccountsFile(file);
  return { ...record };
}

/**
 * アカウントを削除する。実行中タスクから参照されている間は拒否（409）。
 * 認証ファイル（~/.pi/agent/accounts/<id>/）は意図的に残す
 * （実行中セッションが認証を読み続けられるようにするため。再作成時も同じパスを使う）。
 */
export function deleteAccount(id: string): void {
  // accountId は Phase 5 で TaskSummary に正式追加される。それまでは緩く参照する。
  const running = listTasks().some(
    (task) =>
      task.status === "working" &&
      (task as Record<string, unknown>).accountId === id,
  );
  if (running) {
    throw Object.assign(
      new Error("このアカウントで実行中のタスクがあるため削除できません"),
      { status: 409 },
    );
  }
  const file = readAccountsFile();
  const index = file.accounts.findIndex((account) => account.id === id);
  if (index === -1) throw notFound();
  file.accounts.splice(index, 1);
  writeAccountsFile(file);
}
