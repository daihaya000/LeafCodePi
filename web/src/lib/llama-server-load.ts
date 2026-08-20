/**
 * Ensure llama-server has at least one loaded model (router mode).
 * Safe to call repeatedly; no-ops when already loaded or single-model.
 */
export async function ensureLlamaServerModelLoaded(options?: {
  baseUrl?: string;
  preferredId?: string;
  waitMs?: number;
}): Promise<{ ok: boolean; modelId?: string; error?: string }> {
  const root = (options?.baseUrl ?? "http://127.0.0.1:8081").replace(/\/$/, "").replace(/\/v1$/i, "");
  const preferred = options?.preferredId?.trim() ?? "";
  const waitMs = options?.waitMs ?? 180_000;

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
    return { ok: false, error: `timeout waiting for ${target} to load`, modelId: target };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
