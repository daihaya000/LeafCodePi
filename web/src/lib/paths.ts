import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

export function dataDir(): string {
  const override = process.env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

export function storePath(): string {
  return join(dataDir(), "store.json");
}

export function pathKey(value: string, platform = process.platform): string {
  const path = platform === "win32" ? win32.resolve(value) : posix.resolve(value);
  return platform === "win32" ? path.toLowerCase() : path;
}

export function samePath(left: string, right: string, platform = process.platform): boolean {
  return pathKey(left, platform) === pathKey(right, platform);
}

export function sameOrDescendantPath(
  value: string,
  parent: string,
  platform = process.platform,
): boolean {
  const path = pathKey(value, platform);
  const root = pathKey(parent, platform);
  const separator = platform === "win32" ? win32.sep : posix.sep;
  return path === root || path.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
}

/** Base directory for tasks started without a registered project. */
export function noProjectRoot(): string {
  const override = process.env.LEAFCODE_PI_DEFAULT_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), "Documents", "LeafCodePi");
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function noProjectSessionName(date: Date, withSeconds = false): string {
  const minute = `${twoDigits(date.getFullYear() % 100)}${twoDigits(date.getMonth() + 1)}${twoDigits(date.getDate())}_${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}`;
  return withSeconds ? `${minute}${twoDigits(date.getSeconds())}` : minute;
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "EEXIST",
  );
}

/** Create an isolated workspace, adding seconds only when the minute name collides. */
export function noProjectSessionDir(date = new Date()): string {
  const root = noProjectRoot();
  mkdirSync(root, { recursive: true });
  const minuteName = noProjectSessionName(date);
  const candidates = [minuteName, noProjectSessionName(date, true)];
  for (const name of candidates) {
    const directory = join(root, name);
    try {
      mkdirSync(directory);
      return directory;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }
  for (let index = 1; ; index += 1) {
    const directory = join(root, `${candidates[1]}_${index}`);
    try {
      mkdirSync(directory);
      return directory;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
  }
}

export function isAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\");
}
