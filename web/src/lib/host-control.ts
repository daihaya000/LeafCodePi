import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

export const DEFAULT_CONTROL_URL = "http://127.0.0.1:18775";

export type HostLlamaServerAction = "status" | "start" | "stop";

export function hostLlamaServerPath(action: HostLlamaServerAction): string {
  return `/llama-server/${action}`;
}

/** Paths on the host control server for the local en→ja translation service. */
export type HostTranslationAction =
  | "status"
  | "start"
  | "stop"
  | "install"
  | "translate"
  | "override"
  | "unreviewed"
  | "review-results";

export function hostTranslationPath(action: HostTranslationAction): string {
  return `/translation/${action}`;
}

export type HostRestartTarget = "webui" | "host";

export function hostRestartPath(target: HostRestartTarget): string {
  if (target === "host") return "/restart/host";
  return "/restart/webui";
}

export function hostWebUiAuthPath(): string {
  return "/webui/auth";
}

export function isLoopbackControlUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function controlFileUrl(): string | null {
  try {
    const file = join(dataDir(), "host-control.json");
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { url?: string };
    return typeof raw.url === "string" ? raw.url.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/** Always returns a loopback URL (env override must also be loopback). */
export function resolveHostControlUrl(env = process.env): string {
  const fromEnv = env.LEAFCODE_PI_HOST_CONTROL_URL?.trim();
  if (fromEnv && isLoopbackControlUrl(fromEnv)) {
    return fromEnv.replace(/\/$/, "");
  }
  const fromFile = controlFileUrl();
  if (fromFile && isLoopbackControlUrl(fromFile)) return fromFile;
  return DEFAULT_CONTROL_URL;
}

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
