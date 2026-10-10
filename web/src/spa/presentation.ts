import { useEffect, useState } from "react";
import type { WebUiPresentation } from "@shared/webui-presentation.mjs";

let cached: WebUiPresentation | undefined;
let pending: Promise<WebUiPresentation> | undefined;

function validate(value: unknown): WebUiPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid WebUI display information");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "authFileDisplayPath,hostname") throw Error("Invalid WebUI display information");
  for (const [key, limit] of [["hostname", 255], ["authFileDisplayPath", 32768]] as const) {
    const text = record[key];
    if (typeof text !== "string" || !text || text.length > limit || /[\u0000-\u001f\u007f]/.test(text)) throw Error("Invalid WebUI display information");
  }
  return { hostname: record.hostname as string, authFileDisplayPath: record.authFileDisplayPath as string };
}

/** Display-only public fetch; no settings, persistence or owner fallback. */
export function ensureWebUiPresentation(): Promise<WebUiPresentation> {
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  const request = fetch("/webui-bootstrap.json", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5000) })
    .then(async response => {
      if (!response.ok) throw Error("WebUI display information unavailable");
      return validate(await response.json());
    }).then(value => { if (pending === request) cached = value; return value; })
    .finally(() => { if (pending === request) pending = undefined; });
  pending = request;
  return request;
}

export function useWebUiPresentation() {
  const [presentation, setPresentation] = useState(cached), [error, setError] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void ensureWebUiPresentation().then(value => { if (active) setPresentation(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return { presentation, error, retry: () => retry(value => value + 1) };
}

export function resetWebUiPresentationForTests() { cached = undefined; pending = undefined; }
