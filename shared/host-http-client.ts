import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_CONTROL_URL = "http://127.0.0.1:18775";
export type HostLlamaServerAction = "status" | "start" | "stop";
export type HostTranslationAction = "status" | "start" | "stop" | "install" | "translate" | "override" | "unreviewed" | "review-results";
export type HostRestartTarget = "webui" | "backend" | "host";
export const hostLlamaServerPath = (action: HostLlamaServerAction) => `/llama-server/${action}`;
export const hostTranslationPath = (action: HostTranslationAction) => `/translation/${action}`;
export const hostRestartPath = (target: HostRestartTarget) => `/restart/${target}`;
export const hostWebUiAuthPath = () => "/webui/auth";
export const hostPiUpdatePath = () => "/pi/update";

export function isLoopbackControlUrl(value: string): boolean {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    if (["localhost", "[::1]", "::1"].includes(host)) return true;
    const octets = host.split(".");
    return octets.length === 4 && octets[0] === "127" && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  } catch { return false; }
}
/** Discovery metadata only. No mkdir, settings/store read, or Backend path helper. */
function controlMetadataPath(): string {
  const env = process.env;
  const data = env.LEAFCODE_PI_DATA_DIR?.trim() || (process.platform === "win32" && env.APPDATA?.trim()
    ? join(env.APPDATA.trim(), "leafcode-pi") : join(homedir(), ".leafcode-pi"));
  if (env.NODE_ENV === "test") {
    const rel = relative(resolve(tmpdir()), resolve(data));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Host discovery tests must use a temp directory");
  }
  return join(data, "host-control.json");
}
function plainControlUrl(value: string): boolean {
  let url: URL; try { url = new URL(value); } catch { return false; }
  // A configured credential/path/query is an error, not permission to execute at
  // a different fallback Host. Owner callers rely on this fail-closed meaning.
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Host control URL must be a plain origin");
  return isLoopbackControlUrl(value);
}
export function resolveHostControlUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LEAFCODE_PI_HOST_CONTROL_URL?.trim();
  if (configured && plainControlUrl(configured)) return configured.replace(/\/$/, "");
  let discovered: unknown;
  try { discovered = JSON.parse(readFileSync(controlMetadataPath(), "utf8"))?.url; }
  catch { /* Host discovery may be absent during boot; use the standard control port. */ }
  if (typeof discovered === "string" && plainControlUrl(discovered)) return discovered.replace(/\/$/, "");
  return DEFAULT_CONTROL_URL;
}
