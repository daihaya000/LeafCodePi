/**
 * Platform config roots for CodexBarWin-ported helpers.
 *
 * Windows CodexBar used %APPDATA%. Tests still set APPDATA on every OS, so an
 * explicit APPDATA wins. Otherwise Linux uses XDG, macOS uses Application
 * Support - never ~/AppData/Roaming.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function roamingConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const appData = env.APPDATA?.trim();
  if (appData) return appData;
  if (platform === "win32") {
    return join(homedir(), "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return xdg;
  return join(homedir(), ".config");
}
