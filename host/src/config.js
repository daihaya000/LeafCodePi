import { homedir } from "node:os";
import { join } from "node:path";

/** Dedicated port so LeafCode (default 3000) can run at the same time. */
export const DEFAULT_WEBUI_PORT = 3010;

export function dataDir(env = process.env) {
  const override = env.LEAFCODE_PI_DATA_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const roaming = env.APPDATA?.trim();
    if (roaming) return join(roaming, "leafcode-pi");
  }
  return join(homedir(), ".leafcode-pi");
}

export function readPort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return fallback;
}

export function isHeadless(env = process.env, argv = process.argv) {
  return env.LEAFCODE_PI_HEADLESS === "1" || argv.includes("--headless");
}

export function shouldOpenBrowser(env = process.env) {
  return env.LEAFCODE_PI_NO_BROWSER !== "1";
}

export function bindHost(env = process.env) {
  const host = env.LEAFCODE_PI_HOST?.trim();
  return host || "127.0.0.1";
}
