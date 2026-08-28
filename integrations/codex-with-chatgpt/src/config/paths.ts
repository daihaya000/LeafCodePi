import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Resolve the existing LeafCodePi data root, then keep C2C state in its own namespace. */
export function getStateDir(): string {
  const dataOverride = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (dataOverride) return path.join(path.resolve(dataOverride), "c2c");
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "leafcode-pi", "c2c");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "leafcode-pi", "c2c");
  }
  return path.join(home, ".leafcode-pi", "c2c");
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

let windowsAclAvailable: boolean | null = null;

function restrictWindowsFile(file: string): void {
  if (process.platform !== "win32") return;
  if (windowsAclAvailable === false) throw new Error("Windows ACL protection is unavailable");

  const username = process.env.USERNAME?.trim();
  if (!username) throw new Error("USERNAME is not set; cannot protect secure state");
  const principal = process.env.USERDOMAIN?.trim()
    ? `${process.env.USERDOMAIN.trim()}\\${username}`
    : username;

  try {
    execFileSync(
      "icacls",
      [
        file,
        "/inheritance:r",
        "/grant:r",
        `${principal}:(R,W,D)`,
        "/grant:r",
        "*S-1-5-18:(F)",
        "/grant:r",
        "*S-1-5-32-544:(F)",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    windowsAclAvailable = true;
  } catch {
    windowsAclAvailable = false;
    throw new Error("Failed to apply Windows ACL protection to secure state");
  }
}

/** Write a JSON file atomically with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\\n`, { mode: 0o600 });
    try {
      fs.chmodSync(temp, 0o600);
    } catch {
      // Windows uses the explicit ACL below; other platforms may not support chmod.
    }
    restrictWindowsFile(temp);
    fs.renameSync(temp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // ignore cleanup failures after a successful rename
    }
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
