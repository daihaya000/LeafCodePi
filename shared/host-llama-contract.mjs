import { publicTaskOperation } from "./task-collection-contract.mjs";
export const HOST_LLAMA_PATH = "/webui/llama";
export const HOST_LLAMA_HEADER = "x-leafcode-host-llama";
export const HOST_LLAMA_OPERATION_HEADER = "x-leafcode-host-operation";
export const HOST_LLAMA_BODY_LIMIT = 64 * 1024;
export const HOST_LLAMA_RESPONSE_LIMIT = 128 * 1024;
export const HOST_LLAMA_ROUTES = Object.freeze({ status: ["GET"], models: ["GET"], start: ["POST"], stop: ["POST"], "ensure-loaded": ["POST"] });
const text = (v, n) => typeof v === "string" && v.length <= n && !v.includes("\0");
const pid = v => v === null || Number.isSafeInteger(v) && v > 0;
/** Public capabilities only. Errors never relay subprocess stderr or arbitrary Host fields. */
export function publicHostLlamaBody(action, value, status) {
  if (!Object.hasOwn(HOST_LLAMA_ROUTES, action) || !value || typeof value !== "object" || Array.isArray(value)) return null;
  let out;
  if (status >= 400) { if (typeof value.error !== "string") return null; out = { error: "llama-server処理を完了できません" }; }
  else if (action === "models") {
    if (!(value.dir === null || text(value.dir, 32768)) || !(value.defaultModel === null || text(value.defaultModel, 400))) return null;
    for (const key of ["models", "mmprojs", "loras"]) if (!Array.isArray(value[key]) || value[key].length > 300 || value[key].some(name => !text(name, 400))) return null;
    out = { dir: value.dir, models: [...value.models], mmprojs: [...value.mmprojs], loras: [...value.loras], defaultModel: value.defaultModel };
  } else if (action === "status") {
    if (typeof value.running !== "boolean" || !pid(value.pid) || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || !Array.isArray(value.listeningPids) || value.listeningPids.length > 100 || value.listeningPids.some(v => !pid(v) || v === null) || !(value.health === null || text(value.health, 80))) return null;
    out = { running: value.running, pid: value.pid, port: value.port, listeningPids: [...value.listeningPids], health: value.health };
  } else {
    if (typeof value.ok !== "boolean") return null; out = { ok: value.ok };
    if (value.modelId !== undefined) { if (!text(value.modelId, 400)) return null; out.modelId = value.modelId; }
    if (value.pending !== undefined) { if (typeof value.pending !== "boolean") return null; out.pending = value.pending; }
    for (const key of ["pid", "trayPid"]) if (value[key] !== undefined) { if (!pid(value[key])) return null; out[key] = value[key]; }
    if (value.error !== undefined) out.error = "llama-server処理を完了できません";
  }
  if (value.operation !== undefined) { const operation = publicTaskOperation(value.operation); if (!operation) return null; out.operation = operation; }
  return out;
}
