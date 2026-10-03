import { llamaServerBaseUrl } from "@/lib/llama-server-settings";

/**
 * A model load can take minutes, and every caller that arrives while one is in
 * flight would otherwise hold a Next BFF worker for the same wait. One in-flight
 * load per server root is shared, and a caller that joins late still gets the
 * final state instead of starting a second load.
 */
export interface LlamaEnsureLoadedResult {
  ok: boolean;
  modelId?: string;
  error?: string;
  /** The load continues server-side; this caller stopped waiting for it. */
  pending?: boolean;
}

const inFlightLoads = new Map<string, Promise<LlamaEnsureLoadedResult>>();

/**
 * How long the HTTP route waits before releasing the BFF worker. llama-server
 * keeps loading in the background, so a long wait only ties up a request.
 */
export const LLAMA_ENSURE_LOADED_WAIT_MS = 20_000;

/**
 * Ensure llama-server has at least one loaded model (router mode).
 * Safe to call repeatedly; no-ops when already loaded or single-model.
 */
export async function ensureLlamaServerModelLoaded(options?: {
  baseUrl?: string;
  preferredId?: string;
  waitMs?: number;
  /** Caller cancellation; stops polling but leaves the server-side load running. */
  signal?: AbortSignal;
}): Promise<LlamaEnsureLoadedResult> {
  const root = (options?.baseUrl ?? llamaServerBaseUrl(process.env.LEAFCODE_PI_LLAMA_PORT))
    .replace(/\/$/, "")
    .replace(/\/v1$/i, "");
  const preferred = options?.preferredId?.trim() ?? "";
  const waitMs = options?.waitMs ?? 180_000;
  const inflightKey = `${root}\u0000${preferred}`;
  const existing = inFlightLoads.get(inflightKey);
  if (existing) return existing;
  const started = ensureLlamaServerModelLoadedInner(root, preferred, waitMs, options?.signal);
  inFlightLoads.set(inflightKey, started);
  try {
    return await started;
  } finally {
    if (inFlightLoads.get(inflightKey) === started) inFlightLoads.delete(inflightKey);
  }
}

async function ensureLlamaServerModelLoadedInner(
  root: string,
  preferred: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<LlamaEnsureLoadedResult> {
  try {
    const listRes = await fetch(`${root}/models`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!listRes.ok) {
      return { ok: false, error: `GET /models HTTP ${listRes.status}` };
    }
    const body = (await listRes.json()) as { data?: unknown };
    if (!Array.isArray(body.data) || body.data.length === 0) {
      return { ok: false, error: "no models in catalog" };
    }

    type Row = { id: string; status: string };
    const models: Row[] = body.data
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      .map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        status:
          row.status && typeof row.status === "object" && !Array.isArray(row.status)
            ? String((row.status as { value?: unknown }).value ?? "")
            : "",
      }))
      .filter((row) => row.id);

    const loaded = models.filter((m) => m.status === "loaded");
    if (loaded.length > 0) return { ok: true, modelId: loaded[0].id };

    const needsLoad = models.some((m) => m.status === "unloaded" || m.status === "loading");
    if (!needsLoad) {
      // Single-model OpenAI catalog without status.
      return { ok: true, modelId: models[0]?.id };
    }

    const target =
      (preferred && models.find((m) => m.id === preferred || m.id.includes(preferred))?.id) ||
      models.find((m) => m.status === "unloaded")?.id ||
      models[0]?.id;
    if (!target) return { ok: false, error: "no load target" };

    const loadRes = await fetch(`${root}/models/load`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: target }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!loadRes.ok) {
      const text = await loadRes.text().catch(() => "");
      return { ok: false, error: `load failed: HTTP ${loadRes.status} ${text}` };
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      // The caller went away or stopped caring: llama-server keeps loading, so
      // report it as still pending rather than waiting or reporting a failure.
      if (signal?.aborted) return { ok: true, pending: true, modelId: target };
      const again = await fetch(`${root}/models`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (again.ok) {
        const againBody = (await again.json()) as { data?: unknown };
        const rows = Array.isArray(againBody.data) ? againBody.data : [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const id = (row as { id?: unknown }).id;
          const status = (row as { status?: { value?: unknown } }).status?.value;
          if (id === target && status === "loaded") return { ok: true, modelId: target };
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: true, pending: true, modelId: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
