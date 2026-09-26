import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, win32 } from "node:path";
import { promisify } from "node:util";

export type BrowseDrive = { name: string; path: string };

const execFileAsync = promisify(execFile);
const WINDOWS_DRIVES_SCRIPT = String.raw`
[System.IO.DriveInfo]::GetDrives() | ForEach-Object {
  try { if ($_.IsReady) { [Console]::Out.WriteLine($_.Name) } } catch {}
}
`.trim();

/** Only actual mount points in the user's removable-volume locations, never / or system mounts. */
export function linuxDrivePaths(mountInfo: string): string[] {
  const paths = new Set<string>();
  for (const line of mountInfo.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 5) continue;
    const path = fields[4].replace(/\\(040|011|012|134)/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 8)));
    if (path.startsWith("/media/") || path.startsWith("/run/media/") || path === "/mnt" || path.startsWith("/mnt/")) {
      paths.add(path);
    }
  }
  return [...paths];
}

export function windowsDrivePaths(output: string): string[] {
  return [...new Set(output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((path) => /^[A-Za-z]:\\$/.test(path))
    .map((path) => win32.normalize(path.toUpperCase())))];
}

export async function listBrowseDrives(): Promise<BrowseDrive[]> {
  let paths: string[] = [];
  try {
    if (process.platform === "win32") {
      const encoded = Buffer.from(WINDOWS_DRIVES_SCRIPT, "utf16le").toString("base64");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { timeout: 5_000, windowsHide: true, encoding: "utf8" },
      );
      paths = windowsDrivePaths(String(stdout));
    } else if (process.platform === "linux") {
      paths = linuxDrivePaths(await readFile("/proc/self/mountinfo", "utf8"));
    } else if (process.platform === "darwin") {
      const volumes = await readdir("/Volumes", { withFileTypes: true });
      paths = volumes.filter((entry) => entry.isDirectory()).map((entry) => join("/Volumes", entry.name));
    }
  } catch {
    // Drive discovery is best-effort; home and registered projects remain browsable.
  }
  const drives = await Promise.all(paths.map(async (path) => {
    try {
      if (!(await stat(path)).isDirectory()) return null;
      return { name: process.platform === "win32" ? path.slice(0, 2) : basename(path), path };
    } catch {
      return null; // Disconnected or inaccessible volume.
    }
  }));
  return drives.filter((drive): drive is BrowseDrive => drive !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
}
