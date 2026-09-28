import { lstatSync, readFileSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import {
  accountAuthPath, importAccountRecords, listAccounts, resolvePiAgentDir,
  type AccountRecord,
} from "@/lib/accounts";
import {
  accountAnthropicCookiePath, accountOpenCodeCookiePath,
  defaultAnthropicCookiePath, defaultOpenCodeCookiePath, defaultTypesafeCookiePath,
  parseAnthropicConsoleNetscapeText, parseOpenCodeNetscapeText,
  parseTypesafeConsoleCookieInput, saveAccountAnthropicCookieFile,
  saveAccountOpenCodeCookieFile, saveTypesafeCookieFile,
} from "@/lib/codexbar/browser-cookies";
import { cookieHeaderFromNetscapeText } from "@/lib/codexbar/netscape-cookies";
import { accountOllamaCookiePath, defaultOllamaCookiePath, saveOllamaCookieFile } from "@/lib/codexbar/providers/ollama-cloud";
import { readOpenRouterManagementKey, writeOpenRouterAccountConfig } from "@/lib/codexbar/providers/openrouter";
import { readAccountOpenCodeGoWorkspace, writeAccountOpenCodeGoWorkspace } from "@/lib/codexbar/providers/opencode-go";
import { atomicWriteText } from "@/lib/codexbar/utils";
import {
  AUTO_RESUME_MODE_SETTING_KEY, HANG_TIMEOUT_SETTING_KEY,
  clampHangTimeoutMs, isAutoResumeMode,
} from "@/lib/hang-timeout";
import { JEV_MODEL_SETTING_KEY, normalizeJevModelSettings } from "@/lib/jev-model-settings";
import { ALLOWED_SETTING_KEYS, validateSettingValue } from "@/lib/pi/setting-validation";
import { MAX_SETTING_VALUE_CHARS, readSettingsFile, updateSettingsFile } from "@/lib/pi/web-settings";

export type TransferScope = "settings" | "credentials" | "all";
type AuthEntries = Record<string, Record<string, unknown>>;
type CookieName = "anthropic" | "opencode" | "ollama";
type AccountBackup = {
  record: AccountRecord;
  auth: AuthEntries;
  cookies: Partial<Record<CookieName, string>>;
  openrouterManagementKey?: string;
  opencodeWorkspaceId?: string;
};
type CredentialBackup = {
  defaultAuth: AuthEntries;
  accounts: AccountBackup[];
  sharedCookies: Partial<Record<CookieName | "typesafe", string>>;
};
export type SettingsBackup = {
  format: "leafcode-pi-settings";
  version: 1;
  scope: TransferScope;
  exportedAt: string;
  settings?: Record<string, string | number>;
  credentials?: CredentialBackup;
};

const cookieNames: CookieName[] = ["anthropic", "opencode", "ollama"];
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("バックアップ形式が不正です");
  return value as Record<string, unknown>;
}
function readOptionalText(path: string, maxBytes = 1_000_000): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes) invalid("認証ファイルの形式またはサイズが不正です");
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function checkAuthEntries(raw: unknown): AuthEntries {
  const entries: AuthEntries = {};
  for (const [provider, value] of Object.entries(object(raw))) {
    if (!/^[A-Za-z0-9._:-]{1,150}$/.test(provider) || provider === "__proto__") invalid("認証プロバイダーが不正です");
    const credential = object(value);
    if (credential.type === "api_key") {
      // SDK は key/env 未設定のプレースホルダーも auth.json に保存する。
      if (
        (credential.key !== undefined && typeof credential.key !== "string") ||
        (credential.env !== undefined && (
          !credential.env || typeof credential.env !== "object" ||
          Array.isArray(credential.env) ||
          !Object.values(credential.env).every((entry) => typeof entry === "string")
        ))
      ) invalid("APIキー形式が不正です");
    } else if (credential.type === "oauth") {
      // CodexBar が読み取れる access のみの旧形式も保持する。
      if (
        typeof credential.access !== "string" || !credential.access ||
        (credential.refresh !== undefined && credential.refresh !== null && typeof credential.refresh !== "string") ||
        (credential.expires !== undefined && credential.expires !== null &&
          (typeof credential.expires !== "number" || !Number.isFinite(credential.expires)))
      ) invalid("OAuth形式が不正です");
    } else invalid("認証形式が不正です");
    // JSON由来の平文値だけを保存し、プロトタイプ汚染を防ぐ。
    entries[provider] = JSON.parse(JSON.stringify(credential)) as Record<string, unknown>;
  }
  return entries;
}
function readAuth(path: string): AuthEntries {
  const text = readOptionalText(path, MAX_ARCHIVE_BYTES);
  return text ? checkAuthEntries(JSON.parse(text) as unknown) : {};
}
function cookiePaths(authPath: string, accountId: string): Record<CookieName, string> {
  const ollama = accountOllamaCookiePath(accountId);
  if (!ollama) invalid("アカウントIDが不正です");
  return { anthropic: accountAnthropicCookiePath(authPath), opencode: accountOpenCodeCookiePath(authPath), ollama };
}
function readCookies(paths: Partial<Record<CookieName | "typesafe", string>>): Partial<Record<CookieName | "typesafe", string>> {
  const cookies: Partial<Record<CookieName | "typesafe", string>> = {};
  for (const [name, path] of Object.entries(paths) as [CookieName | "typesafe", string][]) {
    const text = readOptionalText(path);
    if (text) cookies[name] = text;
  }
  return cookies;
}

export async function exportSettingsBackup(scope: TransferScope): Promise<SettingsBackup> {
  const backup: SettingsBackup = { format: "leafcode-pi-settings", version: 1, scope, exportedAt: new Date().toISOString() };
  if (scope !== "credentials") {
    const source = readSettingsFile();
    const settings: Record<string, string | number> = {};
    for (const key of [...ALLOWED_SETTING_KEYS, HANG_TIMEOUT_SETTING_KEY, AUTO_RESUME_MODE_SETTING_KEY, JEV_MODEL_SETTING_KEY]) {
      const value = source[key];
      if (typeof value === "string" || (key === HANG_TIMEOUT_SETTING_KEY && typeof value === "number")) settings[key] = value;
    }
    backup.settings = settings;
  }
  if (scope !== "settings") {
    const agentDir = await resolvePiAgentDir();
    const accounts = listAccounts();
    if (accounts.length > 200) invalid("アカウント数が多すぎます");
    backup.credentials = {
      defaultAuth: readAuth(join(agentDir, "auth.json")),
      accounts: accounts.map((record) => {
        const authPath = accountAuthPath(record.id, agentDir);
        const managementKey = readOpenRouterManagementKey(authPath);
        const workspaceId = readAccountOpenCodeGoWorkspace(authPath);
        return {
          record,
          auth: readAuth(authPath),
          cookies: readCookies(cookiePaths(authPath, record.id)),
          ...(managementKey ? { openrouterManagementKey: managementKey } : {}),
          ...(workspaceId ? { opencodeWorkspaceId: workspaceId } : {}),
        };
      }),
      sharedCookies: readCookies({ anthropic: defaultAnthropicCookiePath(), opencode: defaultOpenCodeCookiePath(), ollama: defaultOllamaCookiePath(), typesafe: defaultTypesafeCookiePath() }),
    };
  }
  if (Buffer.byteLength(JSON.stringify(backup), "utf8") > MAX_ARCHIVE_BYTES) invalid("バックアップが大きすぎます");
  return backup;
}

function validateSettings(raw: unknown, accountIds: readonly string[] = []): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(object(raw))) {
    if (key === HANG_TIMEOUT_SETTING_KEY) {
      if (typeof value !== "number" || !Number.isFinite(value) || clampHangTimeoutMs(value) !== value) invalid("ハング設定が不正です");
      result[key] = value;
    } else if (key === AUTO_RESUME_MODE_SETTING_KEY) {
      if (!isAutoResumeMode(value)) invalid("自動再開設定が不正です");
      result[key] = value;
    } else if (key === JEV_MODEL_SETTING_KEY) {
      if (typeof value !== "string" || value.length > MAX_SETTING_VALUE_CHARS) invalid("Jevモデル設定が不正です");
      try { result[key] = JSON.stringify(normalizeJevModelSettings(JSON.parse(value) as unknown)); }
      catch { invalid("Jevモデル設定が不正です"); }
    } else {
      if (!ALLOWED_SETTING_KEYS.has(key) || typeof value !== "string" || value.length > MAX_SETTING_VALUE_CHARS) invalid("設定値が不正です");
      const normalized = validateSettingValue(key, value, accountIds);
      if (normalized === null) invalid(`設定値が不正です: ${key}`);
      result[key] = normalized;
    }
  }
  return result;
}
function validateCookies(raw: unknown, allowed: readonly string[]): Partial<Record<CookieName | "typesafe", string>> {
  const cookies: Partial<Record<CookieName | "typesafe", string>> = {};
  for (const [key, value] of Object.entries(object(raw))) {
    if (!allowed.includes(key) || typeof value !== "string" || value.length > 1_000_000) invalid("cookieの形式が不正です");
    const valid = key === "anthropic" ? parseAnthropicConsoleNetscapeText(value)
      : key === "opencode" ? parseOpenCodeNetscapeText(value)
      : key === "ollama" ? cookieHeaderFromNetscapeText(value, "ollama.com")
      : parseTypesafeConsoleCookieInput(value);
    if (!valid) invalid("cookieの内容が不正です");
    cookies[key as CookieName] = value;
  }
  return cookies;
}
function validateCredentials(raw: unknown): CredentialBackup {
  const value = object(raw);
  if (!Array.isArray(value.accounts) || value.accounts.length > 200) invalid("アカウント一覧が不正です");
  const accounts = value.accounts.map((item): AccountBackup => {
    const entry = object(item);
    const record = object(entry.record) as AccountRecord;
    if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id)) invalid("アカウントIDが不正です");
    if (entry.openrouterManagementKey !== undefined && (typeof entry.openrouterManagementKey !== "string" || entry.openrouterManagementKey.length > 4096)) invalid("管理キーが不正です");
    if (entry.opencodeWorkspaceId !== undefined && (typeof entry.opencodeWorkspaceId !== "string" || !entry.opencodeWorkspaceId.trim() || entry.opencodeWorkspaceId.length > 256)) invalid("OpenCode workspace IDが不正です");
    return { record, auth: checkAuthEntries(entry.auth), cookies: validateCookies(entry.cookies, cookieNames), ...(entry.openrouterManagementKey ? { openrouterManagementKey: entry.openrouterManagementKey as string } : {}), ...(entry.opencodeWorkspaceId ? { opencodeWorkspaceId: entry.opencodeWorkspaceId as string } : {}) };
  });
  const ids = accounts.map(({ record }) => record.id);
  if (new Set(ids).size !== ids.length) invalid("アカウントIDが重複しています");
  return { defaultAuth: checkAuthEntries(value.defaultAuth), accounts, sharedCookies: validateCookies(value.sharedCookies, [...cookieNames, "typesafe"]) };
}
/** Pi SDK / CodexBar と同じ auth.json.lock を取得し、OAuth 更新との競合を避ける。 */
async function writeAuth(path: string, imported: AuthEntries): Promise<void> {
  if (!Object.keys(imported).length) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("認証ファイルのロックを取得できません");
      await delay(25);
    }
  }
  try {
    const current = readAuth(path);
    atomicWriteText(path, `${JSON.stringify({ ...current, ...imported }, null, 2)}\n`, 0o600);
  } finally {
    await rmdir(lock);
  }
}
function writeCookies(cookies: Partial<Record<CookieName | "typesafe", string>>, authPath?: string, accountId?: string): void {
  if (cookies.anthropic) {
    if (authPath) saveAccountAnthropicCookieFile(authPath, cookies.anthropic);
    else atomicWriteText(defaultAnthropicCookiePath(), `${cookies.anthropic.trim()}\n`, 0o600);
  }
  if (cookies.opencode) {
    if (authPath) saveAccountOpenCodeCookieFile(authPath, cookies.opencode);
    else atomicWriteText(defaultOpenCodeCookiePath(), `${cookies.opencode.trim()}\n`, 0o600);
  }
  if (cookies.ollama) {
    if (accountId) saveOllamaCookieFile(accountId, cookies.ollama);
    else atomicWriteText(defaultOllamaCookiePath(), `${cookies.ollama.trim()}\n`, 0o600);
  }
  if (cookies.typesafe) saveTypesafeCookieFile(cookies.typesafe);
}

/** 存在するキーだけマージする。インポートに無い既存資格情報・設定は削除しない。 */
export async function importSettingsBackup(input: unknown): Promise<TransferScope> {
  const raw = object(input);
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_ARCHIVE_BYTES) invalid("バックアップが大きすぎます");
  if (raw.format !== "leafcode-pi-settings" || raw.version !== 1 || !["settings", "credentials", "all"].includes(String(raw.scope))) invalid("未対応のバックアップ形式です");
  const scope = raw.scope as TransferScope;
  if ((scope !== "credentials") !== (raw.settings !== undefined) || (scope !== "settings") !== (raw.credentials !== undefined)) invalid("バックアップの範囲が一致しません");
  const credentials = scope === "settings" ? null : validateCredentials(raw.credentials);
  const settings = scope === "credentials" ? null : validateSettings(raw.settings, credentials?.accounts.map(({ record }) => record.id));
  const agentDir = credentials ? await resolvePiAgentDir() : "";
  // バリデーションが終わるまではディスクに一切書かない。
  if (credentials) {
    importAccountRecords(credentials.accounts.map(({ record }) => record));
    await writeAuth(join(agentDir, "auth.json"), credentials.defaultAuth);
    for (const account of credentials.accounts) {
      const authPath = accountAuthPath(account.record.id, agentDir);
      await writeAuth(authPath, account.auth);
      writeCookies(account.cookies, authPath, account.record.id);
      if (account.openrouterManagementKey) writeOpenRouterAccountConfig(authPath, { managementKey: account.openrouterManagementKey });
      if (account.opencodeWorkspaceId) writeAccountOpenCodeGoWorkspace(authPath, account.opencodeWorkspaceId);
    }
    writeCookies(credentials.sharedCookies);
  }
  if (settings) updateSettingsFile((current) => { Object.assign(current, settings); });
  return scope;
}
