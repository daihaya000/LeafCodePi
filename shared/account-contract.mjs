import { publicConfigurationMutation } from "./configuration-contract.mjs";
/** Pure account routes and public DTOs. Credentials and private runtime data are never projected. */
export const ACCOUNT_ROUTES = Object.freeze({
  accounts: ["GET", "PATCH", "POST"], "accounts/[id]": ["PATCH", "DELETE"],
  "accounts/[id]/auth-status": ["GET"], "accounts/[id]/anthropic-cookie": ["POST", "DELETE"],
  "accounts/[id]/anthropic-baseline": ["POST", "DELETE"], "accounts/[id]/ollama-cookie": ["POST", "DELETE"],
  "accounts/[id]/opencode-go-cookie": ["GET", "POST", "DELETE"], "accounts/[id]/openrouter-baseline": ["POST", "DELETE"],
  "accounts/[id]/openrouter-credits": ["POST", "DELETE"],
  "accounts/[id]/opendesign-cookie": ["POST", "DELETE"],
});
export function accountTarget(path) {
  if (path === "accounts") return { route: path, params: {} };
  const match = /^accounts\/([^/]+)(?:\/(auth-status|anthropic-cookie|anthropic-baseline|ollama-cookie|opencode-go-cookie|opendesign-cookie|openrouter-baseline|openrouter-credits))?$/.exec(path);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    return { route: `accounts/[id]${match[2] ? `/${match[2]}` : ""}`, params: { id } };
  } catch { return null; }
}
const record = value => value && typeof value === "object" && !Array.isArray(value);
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === "string");
const accountFields = ["id", "label", "enabled", "codexResetAutoConsume", "anthropicResetAutoConsume", "providers", "note", "createdAt", "updatedAt"];
function publicAccount(value) {
  if (!record(value) || !["id", "label", "createdAt", "updatedAt"].every(key => typeof value[key] === "string") || typeof value.enabled !== "boolean" || !stringArray(value.providers)) return null;
  if (value.note !== undefined && typeof value.note !== "string") return null;
  for (const key of ["codexResetAutoConsume", "anthropicResetAutoConsume"]) if (value[key] !== undefined && typeof value[key] !== "boolean") return null;
  return Object.fromEntries(accountFields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}
export function publicAccountBody(route, input, status) {
  if (!Object.hasOwn(ACCOUNT_ROUTES, route) || !record(input) || (input.error !== undefined && typeof input.error !== "string")) return null;
  const body = {};
  if (input.error !== undefined) body.error = input.error;
  if (input.accounts !== undefined) {
    if (!Array.isArray(input.accounts)) return null;
    body.accounts = input.accounts.map(publicAccount); if (body.accounts.includes(null)) return null;
  }
  if (input.account !== undefined) { body.account = publicAccount(input.account); if (!body.account) return null; }
  if (input.ok !== undefined) { if (typeof input.ok !== "boolean") return null; body.ok = input.ok; }
  if (input.configured !== undefined) { if (typeof input.configured !== "boolean") return null; body.configured = input.configured; }
  if (input.baselineUsd !== undefined) { if (input.baselineUsd !== null && (typeof input.baselineUsd !== "number" || !Number.isFinite(input.baselineUsd))) return null; body.baselineUsd = input.baselineUsd; }
  if (input.workspaceId !== undefined && route !== "accounts/[id]/opendesign-cookie") { if (input.workspaceId !== null && typeof input.workspaceId !== "string") return null; body.workspaceId = input.workspaceId; }
  if (route.endsWith("/auth-status") && status < 400 && !input.error) {
    if (!stringArray(input.providers) || !record(input.credentialKinds)) return null;
    body.providers = input.providers;
    body.credentialKinds = Object.fromEntries(Object.entries(input.credentialKinds).filter(([provider]) => input.providers.includes(provider)));
    if (Object.values(body.credentialKinds).some(kind => !["oauth", "api_key"].includes(kind))) return null;
    for (const key of ["peer", "ollamaCookieConfigured", "opencodeGoCookieConfigured", "anthropicCookieConfigured", "openrouterManagementKeyConfigured"]) {
      if (typeof input[key] !== "boolean") return null; body[key] = input[key];
    }
    if (input.opendesignCookieConfigured !== undefined) {
      if (typeof input.opendesignCookieConfigured !== "boolean") return null;
      body.opendesignCookieConfigured = input.opendesignCookieConfigured;
    }
    for (const key of ["anthropicCreditBaseline", "openrouterCreditBaseline"]) {
      if (input[key] !== null && (typeof input[key] !== "number" || !Number.isFinite(input[key]))) return null; body[key] = input[key];
    }
  }
  if (status < 400 && !input.error) {
    if (route === "accounts" && !body.accounts && !body.account) return null;
    if (route === "accounts/[id]" && !body.account && body.ok !== true) return null;
    if (!route.endsWith("/auth-status") && route !== "accounts" && route !== "accounts/[id]" && body.ok !== true && !Object.hasOwn(body, "workspaceId")) return null;
  }
  if (input.mutation !== undefined) { const mutation = publicConfigurationMutation(input.mutation); if (!mutation) return null; body.mutation = mutation; }
  return body;
}
