import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** True when the WebUI binds loopback only (no remote exposure). */
export function isLoopbackBind(host) {
  const h = String(host ?? "").trim().toLowerCase();
  return !h || h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export function webUiAuthPath(dataDirPath) {
  return join(dataDirPath, "webui-auth.json");
}

export function readWebUiAuthFile(dataDirPath) {
  try {
    const raw = JSON.parse(readFileSync(webUiAuthPath(dataDirPath), "utf8"));
    if (raw && typeof raw.token === "string" && raw.token.length >= 16) return raw.token;
  } catch {
    /* missing or invalid */
  }
  return null;
}

export function writeWebUiAuthFile(dataDirPath, token) {
  const path = webUiAuthPath(dataDirPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, "utf8");
}

/**
 * Ensure a WebUI access token exists when binding beyond loopback.
 * @returns {{ authRequired: boolean, token: string | null }}
 */
export function ensureWebUiAuth(env, bindHost, dataDirPath) {
  const envToken = env.LEAFCODE_PI_WEBUI_TOKEN?.trim() || null;
  const authRequired = !isLoopbackBind(bindHost);

  if (!authRequired) {
    return { authRequired: false, token: envToken || readWebUiAuthFile(dataDirPath) };
  }

  let token = envToken || readWebUiAuthFile(dataDirPath);
  if (!token) {
    token = randomBytes(32).toString("base64url");
    writeWebUiAuthFile(dataDirPath, token);
  }
  return { authRequired: true, token };
}
