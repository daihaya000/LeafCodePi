import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

export { DEFAULT_CONTROL_URL, hostLlamaServerPath, hostTranslationPath, hostRestartPath,
  hostWebUiAuthPath, hostPiUpdatePath, isLoopbackControlUrl, resolveHostControlUrl } from "@shared/host-http-client";
export type { HostLlamaServerAction, HostTranslationAction, HostRestartTarget } from "@shared/host-http-client";

export function settingsPath(key: string): string {
  return join(dataDir(), "settings", `${key}.json`);
}

export function readSettingValue(key: string): string | null {
  try {
    const file = settingsPath(key);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { value?: string };
    return typeof parsed.value === "string" ? parsed.value : null;
  } catch {
    return null;
  }
}

export function writeSettingValue(key: string, value: string): void {
  const file = settingsPath(key);
  mkdirSync(join(dataDir(), "settings"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ value }, null, 2)}\n`, "utf8");
}
