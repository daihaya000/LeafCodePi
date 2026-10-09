const record = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length <= max;
/** Runtime metadata only; public callers never receive paths or provider warnings. */
export function publicBackendHealthBody(value, status = 200, authorized = true) {
  if (!record(value)) return null;
  if (status >= 400) return typeof value.error === "string" ? { error: "Backend health unavailable" } : null;
  if (typeof value.ok !== "boolean" || value.engine !== "pi" || typeof value.engineOk !== "boolean" ||
      !(value.version === null || text(value.version, 100)) || !Number.isSafeInteger(value.modelCount) || value.modelCount < 0) return null;
  const out = { ok: value.ok, engine: "pi", engineOk: value.engineOk, version: value.version, modelCount: value.modelCount };
  if (value.error !== undefined) {
    if (!(value.error === null || text(value.error, 4096))) return null;
    out.error = value.error === null || authorized ? value.error : "Backend runtime unavailable";
  }
  if (value.startedAt !== undefined) { if (!Number.isFinite(value.startedAt) || value.startedAt <= 0) return null; out.startedAt = value.startedAt; }
  if (value.platform !== undefined) { if (!text(value.platform, 24)) return null; out.platform = value.platform; }
  if (authorized && value.dataDir !== undefined) { if (!text(value.dataDir, 32768)) return null; out.dataDir = value.dataDir; }
  if (authorized && value.warnings !== undefined) {
    if (!Array.isArray(value.warnings) || value.warnings.length > 32 || value.warnings.some(warning => !text(warning, 2048))) return null;
    out.warnings = [...value.warnings];
  }
  return out;
}
