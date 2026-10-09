import { publicTaskOperation } from "./task-collection-contract.mjs";
export const BACKEND_INFORMATION_ROUTES = Object.freeze({ "memory-search": ["POST"], "sysmon/usage": ["GET"], unread: ["GET", "PUT"] });
export const BACKEND_INFORMATION_BODY_LIMIT = 4096;
export function backendInformationTarget(path) { return Object.hasOwn(BACKEND_INFORMATION_ROUTES, path) ? { route: path, params: {} } : null; }
const record = value => value && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const nullable = (value, check) => value === null || check(value);
const percent = value => finite(value) && value >= 0 && value <= 100;
const bytes = value => finite(value) && value >= 0;
const temperature = value => finite(value) && value >= -50 && value <= 150;
const kinds = ["bot", "room", "task"], categories = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"];
const marker = value => record(value) && kinds.includes(value.kind) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 && finite(value.readAt) && value.readAt > 0 ? { kind: value.kind, id: value.id, readAt: value.readAt } : null;
function memoryEntry(value) {
  if (!record(value) || !nullable(value.project, v => typeof v === "string") || !["memory", "user", "failure"].includes(value.target) || !nullable(value.category, v => categories.includes(v)) || !["content", "created", "lastReferenced"].every(key => typeof value[key] === "string")) return null;
  return { project: value.project, target: value.target, category: value.category, content: value.content, created: value.created, lastReferenced: value.lastReferenced };
}
function systemUsage(value) {
  if (!record(value) || value.schema !== "sysmon.usage/v1" || typeof value.available !== "boolean" || !nullable(value.generatedAt, v => typeof v === "string") || !Array.isArray(value.gpus)) return null;
  if (!value.available) return { available: false, reason: "取得に失敗しました", schema: value.schema, generatedAt: null, cpu: null, memory: null, gpus: [] };
  const c = value.cpu, m = value.memory;
  if (!record(c) || !nullable(c.usedPercent, percent) || !Number.isInteger(c.cores) || c.cores < 0 || typeof c.model !== "string" || !nullable(c.tempC, temperature) || !record(m) || !percent(m.usedPercent) || !bytes(m.usedBytes) || !bytes(m.totalBytes)) return null;
  const gpus = [];
  for (const gpu of value.gpus) {
    if (!record(gpu) || typeof gpu.available !== "boolean" || !nullable(gpu.name, v => typeof v === "string") || !nullable(gpu.usedPercent, percent) || !nullable(gpu.vramUsedPercent, percent) || !nullable(gpu.vramUsedBytes, bytes) || !nullable(gpu.vramTotalBytes, bytes) || !nullable(gpu.tempC, temperature) || !nullable(gpu.tempMaxC, temperature)) return null;
    gpus.push({ available: gpu.available, name: gpu.name, usedPercent: gpu.usedPercent, vramUsedPercent: gpu.vramUsedPercent, vramUsedBytes: gpu.vramUsedBytes, vramTotalBytes: gpu.vramTotalBytes, tempC: gpu.tempC, tempMaxC: gpu.tempMaxC, reason: gpu.available ? null : "GPUを取得できません" });
  }
  return { available: true, reason: null, schema: value.schema, generatedAt: value.generatedAt, cpu: { usedPercent: c.usedPercent, cores: c.cores, model: c.model, tempC: c.tempC }, memory: { usedPercent: m.usedPercent, usedBytes: m.usedBytes, totalBytes: m.totalBytes }, gpus };
}
export function publicBackendInformationBody(route, value, status, method) {
  if (!backendInformationTarget(route) || !record(value)) return null;
  let out;
  if (status >= 400) { if (typeof value.error !== "string") return null; out = { error: value.error }; }
  else if (route === "memory-search") {
    if (!Array.isArray(value.results) || value.results.length > 20) return null;
    const results = value.results.map(memoryEntry); if (results.some(row => !row)) return null; out = { results };
  } else if (route === "sysmon/usage") out = systemUsage(value);
  else if (method === "GET") { if (!Array.isArray(value.markers)) return null; const markers = value.markers.map(marker); if (markers.some(row => !row)) return null; out = { markers }; }
  else { if (!finite(value.readAt) || value.readAt <= 0) return null; out = { readAt: value.readAt }; }
  if (!out) return null;
  if (value.operation !== undefined) { const operation = publicTaskOperation(value.operation); if (!operation) return null; out.operation = operation; }
  return out;
}
