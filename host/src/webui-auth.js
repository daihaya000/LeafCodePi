import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFile } from "./secure-file.js";

export const WEBUI_TOKEN_MIN_LENGTH = 4;
export const WEBUI_TOKEN_MAX_LENGTH = 512;
const WEBUI_TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** True when the WebUI binds loopback only (no remote exposure). */
export function isLoopbackBind(host) {
  const h = String(host ?? "").trim().toLowerCase();
  return !h || h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export function webUiAuthPath(dataDirPath) {
  return join(dataDirPath, "webui-auth.json");
}

function normalizeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (
    token.length < WEBUI_TOKEN_MIN_LENGTH ||
    token.length > WEBUI_TOKEN_MAX_LENGTH ||
    !WEBUI_TOKEN_PATTERN.test(token)
  ) return null;
  return token;
}

/** @returns {{ token: string | null, enabled: boolean }} */
export function readWebUiAuthConfig(dataDirPath) {
  try {
    const raw = JSON.parse(readFileSync(webUiAuthPath(dataDirPath), "utf8"));
    return {
      token: normalizeToken(raw?.token),
      enabled: raw?.enabled !== false,
    };
  } catch {
    return { token: null, enabled: true };
  }
}

export function readWebUiAuthFile(dataDirPath) {
  return readWebUiAuthConfig(dataDirPath).token;
}

function writeAuthConfig(dataDirPath, config) {
  const path = webUiAuthPath(dataDirPath);
  const raw = config.token ? { token: config.token } : {};
  if (!config.enabled) raw.enabled = false;
  writeSecretFile(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export function writeWebUiAuthFile(dataDirPath, token) {
  const normalized = normalizeToken(token);
  if (!normalized) {
    throw Object.assign(
      new Error(`token must be ${WEBUI_TOKEN_MIN_LENGTH}-${WEBUI_TOKEN_MAX_LENGTH} URL-safe characters`),
      { status: 400 },
    );
  }
  writeAuthConfig(dataDirPath, { token: normalized, enabled: true });
}

/**
 * Update the user-owned WebUI auth config. `enabled: false` deliberately makes
 * remote access unauthenticated until the user enables it again.
 * @param {{ token?: string, enabled?: boolean }} patch
 * @returns {{ token: string | null, enabled: boolean }}
 */
export function writeWebUiAuthConfig(dataDirPath, patch) {
  const current = readWebUiAuthConfig(dataDirPath);
  const token = patch.token === undefined ? current.token : normalizeToken(patch.token);
  if (patch.token !== undefined && !token) {
    throw Object.assign(
      new Error(`token must be ${WEBUI_TOKEN_MIN_LENGTH}-${WEBUI_TOKEN_MAX_LENGTH} URL-safe characters`),
      { status: 400 },
    );
  }
  const enabled = typeof patch.enabled === "boolean" ? patch.enabled : current.enabled;
  if (enabled && !token) {
    throw Object.assign(new Error("a token is required when WebUI auth is enabled"), { status: 400 });
  }
  writeAuthConfig(dataDirPath, { token, enabled });
  return { token, enabled };
}

/**
 * Ensure a WebUI access token exists when binding beyond loopback.
 * @returns {{ authRequired: boolean, token: string | null }}
 */
export function ensureWebUiAuth(env, bindHost, dataDirPath) {
  const envToken = env.LEAFCODE_PI_WEBUI_TOKEN?.trim() || null;
  const configured = readWebUiAuthConfig(dataDirPath);
  const remote = !isLoopbackBind(bindHost);

  if (!remote || !configured.enabled) {
    return { authRequired: false, token: envToken || configured.token };
  }

  let token = envToken || configured.token;
  if (!token) {
    token = randomBytes(32).toString("base64url");
    writeWebUiAuthConfig(dataDirPath, { token, enabled: true });
  }
  return { authRequired: true, token };
}
