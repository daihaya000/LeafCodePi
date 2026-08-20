/**
 * After llama-server is healthy, ensure at least one model is loaded.
 * Router mode with --no-models-autoload leaves models "unloaded"; chat fails.
 * Usage: node scripts/llama-server-ensure-loaded.mjs [port] [preferredModelId]
 */
const port = Number(process.argv[2] || 8081);
const preferred = String(process.argv[3] || "").trim();
const base = `http://127.0.0.1:${port}`;

async function listModels() {
  const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET /models HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) return [];
  return body.data
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      id: typeof row.id === "string" ? row.id : "",
      status:
        row.status && typeof row.status === "object"
          ? String(row.status.value ?? "")
          : "",
    }))
    .filter((row) => row.id);
}

async function loadModel(id) {
  const res = await fetch(`${base}/models/load`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: id }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /models/load ${id}: HTTP ${res.status} ${text}`);
  }
}

async function waitLoaded(id, budgetMs = 180_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const models = await listModels();
    const row = models.find((m) => m.id === id);
    if (row?.status === "loaded") return;
    // Single-model servers often omit status; presence in /v1/models is enough.
    if (row && !row.status) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`model ${id} did not become loaded within ${budgetMs}ms`);
}

async function main() {
  const models = await listModels();
  if (models.length === 0) {
    console.log("[llama-server] no models reported; nothing to load");
    return;
  }

  const loaded = models.filter((m) => m.status === "loaded");
  const needsLoad = models.some((m) => m.status === "unloaded" || m.status === "loading");
  if (!needsLoad && loaded.length > 0) {
    console.log(`[llama-server] already loaded: ${loaded.map((m) => m.id).join(", ")}`);
    return;
  }
  // No status field at all → single-model OpenAI catalog; nothing to POST.
  if (!needsLoad && loaded.length === 0) {
    console.log(`[llama-server] catalog ready: ${models.map((m) => m.id).join(", ")}`);
    return;
  }

  const target =
    (preferred &&
      models.find((m) => m.id === preferred || m.id.includes(preferred))?.id) ||
    models.find((m) => m.status === "unloaded")?.id ||
    models[0]?.id;

  if (!target) {
    console.log("[llama-server] no load target");
    return;
  }

  if (models.find((m) => m.id === target)?.status === "loaded") {
    console.log(`[llama-server] already loaded: ${target}`);
    return;
  }

  console.log(`[llama-server] loading model: ${target}`);
  await loadModel(target);
  await waitLoaded(target);
  console.log(`[llama-server] loaded: ${target}`);
}

main().catch((err) => {
  console.error("[llama-server] ensure-loaded failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
