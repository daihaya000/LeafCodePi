import { publicConfigurationMutation } from "./configuration-contract.mjs";
/** Public usage protocol, not an SDK/config/credential envelope. */
export const USAGE_ROUTES = Object.freeze({ "codexbar/providers": ["GET", "PUT"], "codexbar/usage": ["GET"], "codexbar/reset-credits": ["GET", "POST"] });
export function usageTarget(path) { return Object.hasOwn(USAGE_ROUTES, path) ? { route: path, params: {} } : null; }
export function usageExternalCommand(path, method) { return path === "codexbar/reset-credits" && method === "POST"; }
const record = value => value && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
/** Only typed primitive fields; arbitrary objects cannot hide under a known public key. */
function project(input, schema) {
  if (!record(input)) return null;
  const output = {};
  for (const [type, names] of Object.entries(schema)) for (const name of names) {
    if (!Object.hasOwn(input, name)) continue;
    const value = input[name], nullable = type.startsWith("nullable"), base = nullable ? type.slice(8).toLowerCase() : type;
    if (!(nullable && value === null) && !(base === "strings" ? strings(value) : base === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === base)) return null;
    output[name] = value;
  }
  return output;
}
const providerSchema = { string: ["id", "instanceId"], nullableString: ["accountId", "accountLabel", "opencodeId", "plan", "resetsAt", "updatedAt", "error"], nullableNumber: ["planMonthlyUsd", "usedPercent", "resetCreditsAvailable"], boolean: ["limited", "maxed", "stale", "usageDisplayOnly"] };
const windowSchema = { string: ["id", "title"], nullableString: ["resetsAt"], nullableNumber: ["usedPercent", "windowMinutes"], boolean: ["countsTowardLimit"] };
const creditSchema = { nullableString: ["title"], nullableNumber: ["used", "limit", "balance"] };
const tokenSchema = { number: ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "responses"], nullableString: ["startedAt"] };
const tokenWindowSchema = { string: ["id", "title", "status"], nullableString: ["validUntil"], number: ["sampledTokens", "sampledPercent"], nullableNumber: ["tokensPerPercent", "estimatedRemainingTokens"] };
const resetSchema = { string: ["id"], nullableString: ["title", "status", "resetType", "description", "expiresAt", "grantedAt"] };
function rows(input, schema) { if (!Array.isArray(input)) return null; const result = input.map(row => project(row, schema)); return result.includes(null) ? null : result; }
export function publicUsageOperation(value) {
  return record(value) && typeof value.id === "string" && /^[0-9a-f-]{36}$/.test(value.id) && ["not-started", "complete", "unknown"].includes(value.execution) ? { id: value.id, execution: value.execution } : null;
}
function publicUsage(input) {
  const body = project(input, { boolean: ["available"], nullableString: ["reason", "schema", "generatedAt"], nullableNumber: ["subscriptionTotalMonthlyUsd"], strings: ["providerOrder"] });
  if (!body || typeof body.available !== "boolean" || !Array.isArray(input.providers)) return null;
  body.providers = [];
  for (const row of input.providers) {
    const provider = project(row, providerSchema); if (!provider || typeof provider.id !== "string") return null;
    provider.windows = rows(row.windows, windowSchema); if (!provider.windows) return null;
    if (row.credits === null) provider.credits = null;
    else { provider.credits = project(row.credits, creditSchema); if (!provider.credits) return null; }
    if (row.tokenUsage !== undefined) {
      provider.tokenUsage = project(row.tokenUsage, tokenSchema); if (!provider.tokenUsage) return null;
      provider.tokenUsage.windows = rows(row.tokenUsage.windows, tokenWindowSchema); if (!provider.tokenUsage.windows) return null;
    }
    body.providers.push(provider);
  }
  if (input.scope !== undefined) {
    body.scope = project(input.scope, { string: ["kind"], nullableString: ["accountId"] });
    if (!body.scope || !["all", "default", "account"].includes(body.scope.kind)) return null;
  }
  if (input.accounts !== undefined) { body.accounts = rows(input.accounts, { string: ["id", "label"], strings: ["providers", "configuredProviders"] }); if (!body.accounts) return null; }
  return body;
}
export function publicUsageBody(route, input, status) {
  if (!Object.hasOwn(USAGE_ROUTES, route) || !record(input) || (input.error !== undefined && typeof input.error !== "string")) return null;
  let body = {};
  if (input.error !== undefined) body.error = input.error;
  if (status < 400 && !input.error) {
    if (route === "codexbar/usage") { body = publicUsage(input); if (!body) return null; }
    else if (route === "codexbar/providers") {
      body.providers = rows(input.providers, { string: ["id", "name"], boolean: ["enabled", "configurable"] });
      if (!body.providers || typeof input.version !== "string") return null; body.version = input.version;
    } else if (input.credits !== undefined) {
      body.credits = rows(input.credits, resetSchema);
      if (!body.credits || typeof input.availableCount !== "number" || !Number.isFinite(input.availableCount) || (input.accountId !== null && typeof input.accountId !== "string")) return null;
      body.availableCount = input.availableCount; body.accountId = input.accountId;
    } else {
      body = project(input, { boolean: ["ok"], string: ["code", "message", "creditId"], nullableString: ["accountId"], nullableNumber: ["windowsReset"] });
      if (!body || typeof body.ok !== "boolean" || typeof body.code !== "string" || typeof body.creditId !== "string") return null;
    }
  }
  if (input.mutation !== undefined) { const mutation = publicConfigurationMutation(input.mutation); if (!mutation) return null; body.mutation = mutation; }
  if (input.operation !== undefined) { const operation = publicUsageOperation(input.operation); if (!operation) return null; body.operation = operation; }
  return body;
}
