const fields = {
  n8n: ["url"], slack: ["clientId"], "google-workspace": ["clientId", "clientSecret"], notion: [],
};

/** Structural validation only. Preset semantics are checked by the owning writer.
 * Returned values may contain credentials: never log or echo this request.
 */
export function parseMcpPresetRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || typeof body.preset !== "string" || !Object.hasOwn(fields, body.preset)) return { ok: false };
  const required = fields[body.preset];
  if (Object.keys(body).some((key) => key !== "preset" && !required.includes(key))
    || !Object.hasOwn(body, "preset")
    || required.some((key) => !Object.hasOwn(body, key) || typeof body[key] !== "string" || !body[key].trim())) return { ok: false };
  return { ok: true, value: Object.fromEntries(["preset", ...required].map((key) => [key, body[key]])) };
}

/** Reload errors may contain SDK/provider credentials: only counters and generic messages escape. */
export function publicMcpReload(value) {
  if (!value || typeof value !== "object"
    || !["reloaded", "deferred", "failed"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || !Array.isArray(value.errors)) return null;
  return { reloaded: value.reloaded, deferred: value.deferred, failed: value.failed,
    errors: value.errors.map(() => "セッションの再読込に失敗しました") };
}
