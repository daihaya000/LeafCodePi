export const PROVIDER_AUTH_ROUTES = Object.freeze({
  "providers/[id]/login": ["POST"], "providers/[id]/login/answer": ["POST", "DELETE"],
  "providers/[id]/login/callback": ["POST"], "providers/[id]/logout": ["POST"],
});
export const PROVIDER_AUTH_EVENTS_PATH = "/internal/provider-login-events";
export const PROVIDER_AUTH_EVENT_LIMIT = 64 * 1024;
export const PROVIDER_AUTH_BUFFER_LIMIT = 1024 * 1024;
const record = value => value && typeof value === "object" && !Array.isArray(value);
export function providerAuthTarget(path) {
  const match = /^providers\/([^/]+)\/(login(?:\/answer|\/callback)?|logout)$/.exec(path);
  if (!match) return null;
  try { return { route: `providers/[id]/${match[2]}`, params: { id: decodeURIComponent(match[1]) } }; } catch { return null; }
}
export function publicAuthOperation(input) {
  if (!record(input) || typeof input.id !== "string" || !/^[0-9a-f-]{36}$/.test(input.id) || !["not-started", "complete", "unknown"].includes(input.execution)) return null;
  return { id: input.id, execution: input.execution };
}
export function publicProviderAuthBody(route, input, status) {
  if (!Object.hasOwn(PROVIDER_AUTH_ROUTES, route) || !record(input) || (input.error !== undefined && typeof input.error !== "string")) return null;
  const body = {};
  if (typeof input.error === "string") body.error = input.error;
  if (status < 400 && !input.error) {
    if (route === "providers/[id]/login") { if (typeof input.sessionId !== "string" || !input.sessionId) return null; body.sessionId = input.sessionId; }
    else { if (input.ok !== true) return null; body.ok = true; }
  }
  if (input.operation !== undefined) { const operation = publicAuthOperation(input.operation); if (!operation) return null; body.operation = operation; }
  return body;
}
const text = value => typeof value === "string" && value.length <= 32768;
const pickText = (input, keys) => Object.fromEntries(keys.filter(key => text(input[key])).map(key => [key, input[key]]));
/** OAuth URLs/device codes are authorized UI data; credential input/SDK objects and exception text are not. */
export function publicProviderLoginEvent(input) {
  if (!record(input)) return null;
  if (input.type === "started" && text(input.providerId) && ["oauth", "api_key"].includes(input.authType)) return { type: "started", ...pickText(input, ["providerId", "sessionId", "accountId"]), authType: input.authType, ...(input.accountId === null ? { accountId: null } : {}) };
  if (input.type === "done" && typeof input.ok === "boolean") return input.ok
    ? { type: "done", ok: true, ...(input.warning ? { warning: "認証は保存されましたが、モデル一覧の同期に失敗しました" } : {}) }
    : { type: "done", ok: false, error: input.error === "ログインをキャンセルしました" ? input.error : "ログインに失敗しました" };
  if (input.type === "prompt" && text(input.id) && record(input.prompt) && ["text", "secret", "manual_code", "select"].includes(input.prompt.type) && text(input.prompt.message)) {
    const prompt = { type: input.prompt.type, ...pickText(input.prompt, ["message", "placeholder"]) };
    if (prompt.type === "select") {
      if (!Array.isArray(input.prompt.options) || input.prompt.options.length > 128 || input.prompt.options.some(row => !record(row) || !text(row.id) || !text(row.label))) return null;
      prompt.options = input.prompt.options.map(row => pickText(row, ["id", "label", "description"]));
    }
    return { type: "prompt", id: input.id, prompt };
  }
  if (input.type === "notify" && record(input.event)) {
    const source = input.event; let event;
    if (source.type === "auth_url" && text(source.url)) event = { type: source.type, ...pickText(source, ["url", "instructions", "callbackUrl"]) };
    else if (source.type === "device_code" && text(source.userCode) && text(source.verificationUri)) {
      event = { type: source.type, ...pickText(source, ["userCode", "verificationUri"]) };
      for (const key of ["intervalSeconds", "expiresInSeconds"]) if (Number.isFinite(source[key]) && source[key] >= 0) event[key] = source[key];
    } else if (["info", "progress"].includes(source.type) && text(source.message)) {
      event = { type: source.type, message: source.message };
      if (Array.isArray(source.links) && source.links.length <= 64 && source.links.every(link => record(link) && text(link.url))) event.links = source.links.map(link => pickText(link, ["url", "label"]));
    } else return null;
    return { type: "notify", event };
  }
  return null;
}
