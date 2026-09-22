/**
 * Best-effort Chrome/Edge cookie decryption.
 * Windows: Local State DPAPI key + Cookies SQLite AES-GCM (v10/v11).
 * Linux: same secret-tool / AES-128-CBC path as leafcode-web-access.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { asRecord } from "@/lib/codexbar/utils";
import {
  LINUX_BROWSER_CONFIGS,
  WINDOWS_BROWSER_CONFIGS,
  chromiumCookieDatabasePath,
  chromiumUserDataDir,
  decryptChromiumSafeStorageCookie,
  deriveChromiumSafeStorageKey,
  listChromiumProfileDirs,
  lookupLinuxSafeStoragePasswordSync,
  type ChromiumBrowserConfig,
} from "./chromium-cookie-crypto";

export type ChromiumCookieRow = {
  hostKey: string;
  name: string;
  value: string;
  path: string;
  expiresUtcChrome: number;
  isSecure: boolean;
};

const linuxSafeStorageKeyCache = new Map<string, Buffer>();

function dpapiUnprotect(ciphertext: Buffer): Buffer | null {
  if (process.platform !== "win32" || ciphertext.length === 0) return null;
  try {
    const b64 = ciphertext.toString("base64");
    const ps = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String(${JSON.stringify(b64)})
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
`;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    ).trim();
    if (!out) return null;
    return Buffer.from(out, "base64");
  } catch {
    return null;
  }
}

function loadChromiumMasterKey(userDataDir: string): Buffer | null {
  try {
    const localStatePath = join(userDataDir, "Local State");
    if (!existsSync(localStatePath)) return null;
    const root = asRecord(JSON.parse(readFileSync(localStatePath, "utf8")));
    const osCrypt = asRecord(root?.os_crypt);
    const encryptedKeyB64 =
      typeof osCrypt?.encrypted_key === "string" ? osCrypt.encrypted_key : null;
    if (!encryptedKeyB64) return null;
    let protectedKey = Buffer.from(encryptedKeyB64, "base64");
    if (
      protectedKey.length >= 5 &&
      protectedKey.subarray(0, 5).toString("ascii") === "DPAPI"
    ) {
      protectedKey = protectedKey.subarray(5);
    }
    return dpapiUnprotect(protectedKey);
  } catch {
    return null;
  }
}

function loadLinuxSafeStorageKey(secretToolApp?: string): Buffer | null {
  const cacheKey = secretToolApp ?? "";
  const cached = linuxSafeStorageKeyCache.get(cacheKey);
  if (cached) return cached;
  const { password, cacheable } = lookupLinuxSafeStoragePasswordSync(secretToolApp);
  const key = deriveChromiumSafeStorageKey(password, "linux");
  if (cacheable) linuxSafeStorageKeyCache.set(cacheKey, key);
  return key;
}

function decryptChromeCookie(
  encrypted: Buffer,
  masterKey: Buffer | null,
): string | null {
  if (encrypted.length < 4) return null;
  const prefix = encrypted.subarray(0, 3).toString("ascii");

  if ((prefix === "v10" || prefix === "v11") && masterKey && masterKey.length > 0) {
    const payload = encrypted.subarray(3);
    if (payload.length <= 12 + 16) return null;
    try {
      const nonce = payload.subarray(0, 12);
      const tag = payload.subarray(payload.length - 16);
      const ciphertext = payload.subarray(12, payload.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch {
      /* fall through */
    }
  }

  let ciphertext = encrypted;
  if (prefix === "v10" || prefix === "v11" || prefix === "v20") {
    ciphertext = encrypted.subarray(3);
  }
  const legacy = dpapiUnprotect(ciphertext);
  return legacy ? legacy.toString("utf8") : null;
}

function openSqliteReadonlyCopy(dbPath: string): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  cleanup: () => void;
} | null {
  try {
    // Dynamic require: Node 22+ node:sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean },
      ) => {
        prepare: (sql: string) => {
          all: (...params: unknown[]) => Record<string, unknown>[];
        };
        close: () => void;
      };
    };

    const tmpDir = join(tmpdir(), "leafcode-pi-cookies");
    mkdirSync(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${randomUUID()}.db`);
    copyFileSync(dbPath, tmp);
    // Chrome also uses -wal/-shm; best-effort copy
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${dbPath}${suffix}`;
      if (existsSync(/* turbopackIgnore: true */ side)) {
        try {
          copyFileSync(side, `${tmp}${suffix}`);
        } catch {
          /* ignore */
        }
      }
    }
    const db = new DatabaseSync(tmp, { readOnly: true });
    return {
      db,
      cleanup: () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
          try {
            unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      },
    };
  } catch {
    return null;
  }
}

export function listChromiumProfiles(userDataDir: string): string[] {
  return listChromiumProfileDirs(userDataDir);
}

function chromeExpiryToDate(expiresUtc: number): Date | null {
  if (expiresUtc <= 0) return null;
  const chromeEpochOffsetMicroseconds = 11_644_473_600_000_000;
  const unixMs = (expiresUtc - chromeEpochOffsetMicroseconds) / 1000;
  if (unixMs <= 0) return null;
  const d = new Date(unixMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type ChromiumBrowserRoot = {
  name: string;
  userData: string;
  secretToolApp?: string;
};

function browserRootsFromConfigs(
  configs: ChromiumBrowserConfig[],
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): ChromiumBrowserRoot[] {
  return configs.map((config) => ({
    name: config.name,
    userData: chromiumUserDataDir(config, home, env),
    secretToolApp: config.secretToolApp,
  }));
}

export function listChromiumBrowserRoots(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.Dict<string> = process.env,
): ChromiumBrowserRoot[] {
  if (platform === "linux") {
    // Ubuntu's Chromium Snap keeps its profile outside ~/.config.
    return [
      ...browserRootsFromConfigs(LINUX_BROWSER_CONFIGS, home, env),
      {
        name: "Chromium (Snap)",
        userData: join(home, "snap/chromium/common/chromium"),
        secretToolApp: "chromium",
      },
    ];
  }
  if (platform === "win32") {
    return browserRootsFromConfigs(WINDOWS_BROWSER_CONFIGS, home, env);
  }
  return [];
}

function readCookieMetaVersion(db: { prepare: (sql: string) => { all: () => Record<string, unknown>[] } }): number {
  try {
    const rows = db.prepare("SELECT value FROM meta WHERE key = 'version'").all();
    const value = rows[0]?.value;
    if (typeof value === "number") return Math.floor(value);
    if (typeof value === "string") return parseInt(value, 10) || 0;
  } catch {
    /* missing meta table is fine */
  }
  return 0;
}

/**
 * Read decrypted cookies from a Chromium profile Cookies DB.
 * `hostFilter` returns true for host_key values to keep.
 * Linux uses secret-tool + AES-128-CBC; Windows stays DPAPI + AES-GCM.
 */
export function readChromiumCookiesFromProfile(
  profileDir: string,
  hostFilter: (hostKey: string) => boolean,
  options?: { secretToolApp?: string; platform?: NodeJS.Platform },
): ChromiumCookieRow[] {
  const cookieDb = chromiumCookieDatabasePath(profileDir);
  if (!cookieDb) return [];

  const platform = options?.platform ?? process.platform;
  const masterKey =
    platform === "win32"
      ? loadChromiumMasterKey(dirname(profileDir))
      : platform === "linux"
        ? loadLinuxSafeStorageKey(options?.secretToolApp)
        : null;
  const opened = openSqliteReadonlyCopy(cookieDb);
  if (!opened) return [];

  try {
    const stripHash =
      platform === "linux" && readCookieMetaVersion(opened.db) >= 24;
    const rows = opened.db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure
         FROM cookies ORDER BY creation_utc`,
      )
      .all() as Array<{
      host_key: string;
      name: string;
      value: string | null;
      encrypted_value: Buffer | Uint8Array | null;
      path: string | null;
      expires_utc: number | bigint | null;
      is_secure: number | boolean | null;
    }>;

    const out: ChromiumCookieRow[] = [];
    const now = Date.now();
    for (const row of rows) {
      const hostKey = String(row.host_key ?? "");
      if (!hostFilter(hostKey)) continue;

      let value =
        typeof row.value === "string" && row.value.length > 0 ? row.value : "";
      if (!value && row.encrypted_value) {
        const enc = Buffer.from(row.encrypted_value as Uint8Array);
        value =
          platform === "linux"
            ? decryptChromiumSafeStorageCookie(enc, masterKey ?? Buffer.alloc(0), stripHash) ?? ""
            : decryptChromeCookie(enc, masterKey) ?? "";
      }
      if (!value) continue;

      const expiresUtc = Number(row.expires_utc ?? 0);
      const expiresAt = chromeExpiryToDate(expiresUtc);
      if (expiresAt && expiresAt.getTime() <= now) continue;

      out.push({
        hostKey,
        name: String(row.name ?? ""),
        value,
        path: row.path && row.path.startsWith("/") ? row.path : "/",
        expiresUtcChrome: expiresUtc,
        isSecure: Boolean(row.is_secure),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    opened.cleanup();
  }
}

/** Stable fingerprint so we can unit-test without real browser DBs. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export { chromeExpiryToDate, decryptChromeCookie, loadChromiumMasterKey };
