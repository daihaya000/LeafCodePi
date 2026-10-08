import { publicConfigurationMutation } from "./configuration-contract.mjs";
/** Pure routes and public projections. No SDK objects or credentials cross this boundary. */
export const PROVIDER_ROUTES = Object.freeze({
  models: ["GET"], providers: ["GET"], "providers/[id]": ["PATCH"], "providers/[id]/base-url": ["GET", "PUT"],
  "provider-models": ["GET"], "provider-models/[key]": ["PATCH"], "provider-models/order": ["PATCH"],
});
export function providerTarget(path) {
  if (Object.hasOwn(PROVIDER_ROUTES, path) && !path.includes("[")) return { route: path, params: {} };
  const provider = /^providers\/([^/]+)(\/base-url)?$/.exec(path);
  const model = /^provider-models\/([^/]+)$/.exec(path);
  try {
    if (provider) return { route: `providers/[id]${provider[2] ?? ""}`, params: { id: decodeURIComponent(provider[1]) } };
    if (model) return { route: "provider-models/[key]", params: { key: decodeURIComponent(model[1]) } };
  } catch { /* Invalid encoded identifiers never reach the owner. */ }
  return null;
}
const record = value => value && typeof value === "object" && !Array.isArray(value);
const select = (input, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
const optionFields = ["value", "label", "providerID", "modelID", "accountId", "accountLabel", "subscription", "input", "reasoning", "thinkingLevels", "defaultThinkingLevel", "codexbarUsedPercent", "codexbarIntegratedUsedPercent", "codexbarDisplayOnly", "codexbarLimited", "codexbarMaxed", "codexbarUnavailable", "codexbarStale", "routingMode", "routingCandidateCount", "avgTokensPerSecond"];
const authFields = ["id", "name", "authenticated", "accountRoutingMode", "methods", "authSource", "authLabel", "subscription", "oauthAvailable", "highlighted", "baseUrl"];
const catalogFields = ["id", "name", "enabled", "accountId", "accountLabel", "accountIds"];
const modelFields = ["id", "name", "enabled", "contextWindow", "thinkingLevels", "defaultThinkingLevel"];
export function publicProviderBody(route, input, status) {
  if (!Object.hasOwn(PROVIDER_ROUTES, route) || !record(input) || (input.error !== undefined && typeof input.error !== "string")) return null;
  const body = {};
  if (input.error !== undefined) body.error = input.error;
  if (status < 400 && !input.error) {
    if (route === "models") {
      if (!Array.isArray(input.models) || input.models.some(row => !record(row) || !["value", "label", "providerID", "modelID"].every(key => typeof row[key] === "string"))) return null;
      body.models = input.models.map(row => select(row, optionFields));
    } else if (route === "providers" || route === "provider-models") {
      if (!Array.isArray(input.providers) || input.providers.some(row => !record(row) || typeof row.id !== "string" || typeof row.name !== "string")) return null;
      if (route === "providers") {
        if (input.providers.some(row => typeof row.authenticated !== "boolean")) return null;
        body.providers = input.providers.map(row => select(row, authFields));
      } else {
        if (input.providers.some(row => typeof row.enabled !== "boolean" || !Array.isArray(row.models) || row.models.some(model => !record(model) || typeof model.id !== "string" || typeof model.name !== "string" || typeof model.enabled !== "boolean"))) return null;
        body.providers = input.providers.map(row => ({ ...select(row, catalogFields), models: row.models.map(model => select(model, modelFields)) }));
      }
    } else if (route.endsWith("/base-url")) {
      if (typeof input.baseUrl !== "string") return null; body.baseUrl = input.baseUrl;
    } else if (route === "providers/[id]") {
      if (!["integrated", "separate"].includes(input.accountRoutingMode)) return null; body.accountRoutingMode = input.accountRoutingMode;
    } else { if (input.ok !== true) return null; body.ok = true; }
  } else {
    // Partial saves can still return their validated public acknowledgement fields.
    if (typeof input.baseUrl === "string") body.baseUrl = input.baseUrl;
    if (input.ok === true) body.ok = true;
    if (["integrated", "separate"].includes(input.accountRoutingMode)) body.accountRoutingMode = input.accountRoutingMode;
  }
  if (input.mutation !== undefined) {
    const mutation = publicConfigurationMutation(input.mutation); if (!mutation) return null; body.mutation = mutation;
  }
  return body;
}
