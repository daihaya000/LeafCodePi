import { networkInterfaces } from "node:os";
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

/** Tailscale uses CGNAT 100.64.0.0/10 for userspace addresses. */
export function isTailscaleCgnatIPv4(address) {
  const parts = String(address).split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Prefer a NIC named Tailscale; otherwise any CGNAT 100.64/10 IPv4.
 * @param {NodeJS.Dict<import("node:os").NetworkInterfaceInfo[] | undefined>} [interfaces]
 */
export function findTailscaleIPv4(interfaces = networkInterfaces()) {
  const entries = Object.entries(interfaces ?? {});
  for (const [name, list] of entries) {
    if (!list || !/tailscale/i.test(name)) continue;
    for (const info of list) {
      if (info.internal) continue;
      const family = String(info.family);
      if (family !== "IPv4" && family !== "4") continue;
      return info.address;
    }
  }
  for (const [, list] of entries) {
    if (!list) continue;
    for (const info of list) {
      if (info.internal) continue;
      const family = String(info.family);
      if (family !== "IPv4" && family !== "4") continue;
      if (isTailscaleCgnatIPv4(info.address)) return info.address;
    }
  }
  return null;
}

/**
 * Resolve Next.js bind address.
 * - unset / `tailscale` → Tailscale IPv4 (fallback 127.0.0.1)
 * - `0.0.0.0` / explicit IP → as-is
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ findTailscale?: () => string | null }} [deps]
 */
export function bindHost(env = process.env, deps = {}) {
  const raw = env.LEAFCODE_PI_HOST?.trim();
  const find = deps.findTailscale ?? findTailscaleIPv4;
  if (!raw || raw.toLowerCase() === "tailscale") {
    return find() || "127.0.0.1";
  }
  return raw;
}

/**
 * URL host for browser / health checks. Never returns 0.0.0.0.
 * @param {string} bind
 * @param {{ findTailscale?: () => string | null }} [deps]
 */
export function publicHost(bind, deps = {}) {
  if (!bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]") {
    const find = deps.findTailscale ?? findTailscaleIPv4;
    return find() || "127.0.0.1";
  }
  return bind;
}

export function webUiUrl(bind, port, deps = {}) {
  return `http://${publicHost(bind, deps)}:${port}`;
}
