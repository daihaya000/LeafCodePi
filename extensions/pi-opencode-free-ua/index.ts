import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-opencode-free-ua
 * --------------------
 * Makes OpenCode Zen free-tier models usable from Pi.
 *
 * Two findings (verified against https://opencode.ai/zen on 2026-10):
 *   1. The free-tier client gate checks the `x-opencode-client` request header.
 *      `User-Agent` alone is NOT enough (still 403 FreeTierError). Injecting
 *      `x-opencode-client: opencode` passes the gate.
 *   2. The gate only accepts that header on the **chat/completions** endpoint.
 *      On the **responses** endpoint it still returns 403 regardless of headers.
 *      Pi routes `muse-spark-*-contributor-free` via openai-responses (/responses),
 *      so those models are re-registered here to use openai-completions
 *      (/chat/completions) instead. Every other opencode model is kept as-is.
 */

// Model ids that Pi ships on openai-responses but that must be flipped to
// openai-completions to pass the free-tier gate.
const FLIP_TO_COMPLETIONS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

function resolveCatalogPath(): string | null {
  const rel = "dist/providers/data/opencode.json";
  // 1) Resolve the pi-ai package from the running pi entry, then join the data path.
  try {
    const entry = process.argv[1] || "";
    if (entry) {
      const r = createRequire(join(entry, "x.js"));
      const main = r.resolve("@earendil-works/pi-ai");
      const pkgDir = dirname(dirname(main)); // .../pi-ai/dist -> .../pi-ai
      const p = join(pkgDir, rel);
      if (existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  // 2) cwd-based (LeafCodePi layout: <cwd>/web/node_modules/...).
  const candidates = [
    join(process.cwd(), "web/node_modules/@earendil-works/pi-ai", rel),
    join(process.cwd(), "node_modules/@earendil-works/pi-ai", rel),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

export default function (pi: ExtensionAPI): void {
  // (1) Inject the client-identity header on opencode requests.
  //     OpenCode requests already carry an `x-opencode-session` header (added by
  //     Pi's opencode provider wrapper), so that presence is a precise signal to
  //     target only opencode traffic and leave other providers untouched.
  pi.on("before_provider_headers", (event) => {
    if (
      "x-opencode-session" in event.headers &&
      !("x-opencode-client" in event.headers)
    ) {
      event.headers["x-opencode-client"] = "opencode";
    }
  });

  // (2) Re-register opencode models, flipping the free responses-API models to
  //     openai-completions so they hit /chat/completions.
  const catalogPath = resolveCatalogPath();
  if (!catalogPath) return;
  let catalog: Record<string, Record<string, any>>;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    return;
  }
  const models: any[] = [];
  for (const section of Object.values(catalog)) {
    if (!section || typeof section !== "object") continue;
    for (const model of Object.values(section) as any[]) {
      const copy = { ...model };
      if (FLIP_TO_COMPLETIONS.has(copy.id)) copy.api = "openai-completions";
      models.push(copy);
    }
  }
  if (models.length > 0) {
    pi.registerProvider("opencode", { models });
  }
}
