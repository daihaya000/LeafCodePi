/**
 * Best-effort Chrome/Edge cookie decryption on Windows (CodexBarWin parity).
 * Local State DPAPI key + Cookies SQLite AES-GCM (v10/v11).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { asRecord } from "@/lib/codexbar/utils";

export type ChromiumCookieRow = {
  hostKey: string;
  name: string;
  value: string;
  path: string;
  expiresUtcChrome: number;
  isSecure: boolean;
};

function localAppData(): string {
  return (
    process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
  );
}

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
      if (existsSync(side)) {
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

function enumerateProfiles(userDataDir: string): string[] {
  const profiles: string[] = [];
  const defaultProfile = join(userDataDir, "Default");
  if (existsSync(defaultProfile)) profiles.push(defaultProfile);
  try {
    for (const name of readdirSync(userDataDir)) {
      if (/^Profile /i.test(name)) {
        profiles.push(join(userDataDir, name));
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(profiles)];
}

function chromeExpiryToDate(expiresUtc: number): Date | null {
  if (expiresUtc <= 0) return null;
  const chromeEpochOffsetMicroseconds = 11_644_473_600_000_000;
  const unixMs = (expiresUtc - chromeEpochOffsetMicroseconds) / 1000;
  if (unixMs <= 0) return null;
  const d = new Date(unixMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function listChromiumBrowserRoots(): Array<{
  name: string;
  userData: string;
}> {
  const local = localAppData();
  return [
    { name: "Chrome", userData: join(local, "Google", "Chrome", "User Data") },
    { name: "Edge", userData: join(local, "Microsoft", "Edge", "User Data") },
  ];
}

export function listChromiumProfiles(userDataDir: string): string[] {
  return enumerateProfiles(userDataDir);
}

/**
 * Read decrypted cookies from a Chromium profile Cookies DB.
 * `hostFilter` returns true for host_key values to keep.
 */
export function readChromiumCookiesFromProfile(
  profileDir: string,
  hostFilter: (hostKey: string) => boolean,
): ChromiumCookieRow[] {
  const cookieDb = join(profileDir, "Network", "Cookies");
  if (!existsSync(cookieDb)) return [];

  const masterKey = loadChromiumMasterKey(dirname(profileDir));
  const opened = openSqliteReadonlyCopy(cookieDb);
  if (!opened) return [];

  try {
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
        value = decryptChromeCookie(enc, masterKey) ?? "";
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
