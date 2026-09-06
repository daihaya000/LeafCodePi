import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deleteCredential(): boolean;
};
type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;
type KeyringModule = { Entry: KeyringEntryConstructor };
type KeyringRequire = ((id: string) => unknown) & { resolve(id: string): string };
type HeaderSecretStore = {
  read(account: string): string | undefined;
  write(account: string, payload: string): void;
  remove(account: string): void;
};

type StoredHeaderRecord = {
  headers: Record<string, string>;
  serverUrl: string;
};

const require = createRequire(import.meta.url);
const HEADER_SECRET_SERVICE = "pi-mcp-adapter.headers";
const TEST_AUTH_STORE_ENV = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
const HEADER_VALUE_LIMIT = 16_384;

let KeyringEntryClass: KeyringEntryConstructor | undefined;
const memoryHeaderEntries = new Map<string, string>();

export class HeaderCredentialStoreError extends Error {
  readonly code = "HEADER_CREDENTIAL_STORE_UNAVAILABLE";
  readonly operation: "read" | "write" | "remove";

  constructor(message: string, operation: "read" | "write" | "remove", cause: unknown) {
    super(message, { cause });
    this.name = "HeaderCredentialStoreError";
    this.operation = operation;
  }
}

export type HeaderCredentialStatus =
  | { status: "present" }
  | { status: "missing" }
  | { status: "url-mismatch" }
  | { status: "unavailable"; message: string };

const memoryHeaderSecretStore: HeaderSecretStore = {
  read: (account) => memoryHeaderEntries.get(account),
  write: (account, payload) => memoryHeaderEntries.set(account, payload),
  remove: (account) => memoryHeaderEntries.delete(account),
};

const keyringHeaderSecretStore: HeaderSecretStore = {
  read: (account) => getKeyringEntry(HEADER_SECRET_SERVICE, account).getPassword() ?? undefined,
  write: (account, payload) => getKeyringEntry(HEADER_SECRET_SERVICE, account).setPassword(payload),
  remove: (account) => { getKeyringEntry(HEADER_SECRET_SERVICE, account).deleteCredential(); },
};

function getHeaderSecretStore(): HeaderSecretStore {
  return process.env[TEST_AUTH_STORE_ENV] === "memory" ? memoryHeaderSecretStore : keyringHeaderSecretStore;
}

function getKeyringEntry(service: string, account: string): KeyringEntry {
  try {
    KeyringEntryClass ??= loadKeyringEntryClass();
    return new KeyringEntryClass(service, account);
  } catch (error) {
    throw new Error("HTTP header secure credential storage is unavailable. Configure the OS credential store and retry.", { cause: error });
  }
}

function loadKeyringEntryClass(keyringRequire: KeyringRequire = require, platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): KeyringEntryConstructor {
  try {
    return (keyringRequire("@napi-rs/keyring") as KeyringModule).Entry;
  } catch (loaderError) {
    try {
      return loadKeyringNativeBindingFallback(keyringRequire, platform, arch).Entry;
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Failed to load @napi-rs/keyring; native binding fallback also failed: ${message}`, { cause: loaderError });
    }
  }
}

function loadKeyringNativeBindingFallback(keyringRequire: KeyringRequire, platform: NodeJS.Platform, arch: NodeJS.Architecture): KeyringModule {
  const suffixes: string[] = [];
  if (platform === "win32") {
    if (arch === "arm64") suffixes.push("win32-arm64-msvc");
    if (arch === "x64") suffixes.push("win32-x64-msvc");
    if (arch === "ia32") suffixes.push("win32-ia32-msvc");
  } else if (platform === "darwin") {
    if (arch === "arm64") suffixes.push("darwin-arm64");
    if (arch === "x64") suffixes.push("darwin-x64");
  } else if (platform === "linux") {
    if (arch === "arm64") suffixes.push("linux-arm64-gnu", "linux-arm64-musl");
    if (arch === "arm") suffixes.push("linux-arm-gnueabihf");
    if (arch === "riscv64") suffixes.push("linux-riscv64-gnu");
    if (arch === "x64") suffixes.push("linux-x64-gnu", "linux-x64-musl");
  } else if (platform === "freebsd" && arch === "x64") {
    suffixes.push("freebsd-x64");
  }

  let lastError: unknown;
  for (const suffix of suffixes) {
    try {
      const packageJsonPath = keyringRequire.resolve(`@napi-rs/keyring-${suffix}/package.json`);
      return keyringRequire(join(dirname(packageJsonPath), `keyring.${suffix}.node`)) as KeyringModule;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No compatible keyring native binding");
}

function accountFor(serverName: string): string {
  if (typeof serverName !== "string" || !serverName) throw new Error("Invalid MCP server name");
  return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
}

function parseRecord(serverName: string, payload: string): StoredHeaderRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(`Stored HTTP headers for ${serverName} have invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Stored HTTP headers have invalid shape");
  const record = parsed as { headers?: unknown; serverUrl?: unknown };
  if (!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers) || typeof record.serverUrl !== "string") {
    throw new Error("Stored HTTP headers have invalid shape");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(record.headers)) {
    if (typeof value !== "string" || value.length > HEADER_VALUE_LIMIT) throw new Error("Stored HTTP headers have invalid values");
    Object.defineProperty(headers, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  try {
    new Headers(headers);
  } catch {
    throw new Error("Stored HTTP headers have invalid names or values");
  }
  return { headers, serverUrl: record.serverUrl };
}

function readRecord(store: HeaderSecretStore, serverName: string): StoredHeaderRecord | undefined {
  const payload = store.read(accountFor(serverName));
  return payload === undefined ? undefined : parseRecord(serverName, payload);
}

function readRecordSafely(serverName: string): StoredHeaderRecord | undefined {
  try {
    return readRecord(getHeaderSecretStore(), serverName);
  } catch (error) {
    throw new HeaderCredentialStoreError(
      `Failed to read HTTP headers for ${serverName} from the OS secure credential store`,
      "read",
      error,
    );
  }
}

export function getMcpHeadersForUrl(serverName: string, serverUrl: string): Record<string, string> | undefined {
  const record = readRecordSafely(serverName);
  return record?.serverUrl === serverUrl ? { ...record.headers } : undefined;
}

export function saveMcpHeadersForUrl(serverName: string, headers: Record<string, string>, serverUrl: string): void {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.trim() || typeof value !== "string" || value.length > HEADER_VALUE_LIMIT || /[\r\n]/.test(value)) {
      throw new Error("HTTP header name or value is invalid");
    }
    Object.defineProperty(normalized, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  new Headers(normalized);
  const payload = JSON.stringify({ headers: normalized, serverUrl });
  try {
    getHeaderSecretStore().write(accountFor(serverName), payload);
  } catch (error) {
    throw new HeaderCredentialStoreError(
      `Failed to save HTTP headers for ${serverName} to the OS secure credential store`,
      "write",
      error,
    );
  }
}

export function removeMcpHeaders(serverName: string): void {
  try {
    getHeaderSecretStore().remove(accountFor(serverName));
  } catch (error) {
    throw new HeaderCredentialStoreError(
      `Failed to remove HTTP headers for ${serverName} from the OS secure credential store`,
      "remove",
      error,
    );
  }
}

export function inspectMcpHeadersForUrl(serverName: string, serverUrl: string): HeaderCredentialStatus {
  try {
    const record = readRecordSafely(serverName);
    if (!record) return { status: "missing" };
    if (record.serverUrl !== serverUrl) return { status: "url-mismatch" };
    return { status: "present" };
  } catch (error) {
    if (!(error instanceof HeaderCredentialStoreError)) throw error;
    return { status: "unavailable", message: "HTTP header secure credential store unavailable. Configure or unlock the OS credential store and retry." };
  }
}
