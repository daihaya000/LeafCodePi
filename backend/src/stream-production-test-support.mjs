import assert from "node:assert/strict";
import { cpSync, mkdirSync, copyFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGateway } from "../../scripts/build-gateway.mjs";
export const STREAM_TEST_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const PRODUCTION_STREAM_ROUTES = ["tasks/[id]/events", "bots/[id]/events", "bots/events", "bots/rooms/[id]/events", "tasks/[id]/media", "tasks/[id]/image", "tasks/[id]/message-image", "bots/rooms/[id]/files/[file]", "bots/rooms/[id]/images/[file]", "browse/icon", "projects/[id]/icon", "link-preview/image", "profile", "tts/synthesize", "providers/[id]/login/events"];
/** Compile the real, audited gateway routes in an isolated directory, never a framework adapter. */
export async function buildStreamProductionApp(app) {
  const root = STREAM_TEST_ROOT;
  // The isolated owner fixture keeps its ESM SDK externals in Backend, not Web.
  symlinkSync(join(root, "backend/node_modules"), join(dirname(app), "node_modules"), process.platform === "win32" ? "junction" : "dir");
  for (const folder of ["gateway/src", "shared", "web/src/app/api", "web/src/lib"]) cpSync(join(root, folder), join(app, folder), { recursive: true });
  mkdirSync(join(app, "docs/plans"), { recursive: true });
  copyFileSync(join(root, "docs/plans/next-thin-phase0.json"), join(app, "docs/plans/next-thin-phase0.json"));
  for (const path of ["web", "gateway"]) symlinkSync(join(root, "web/node_modules"), join(app, path, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const built = buildGateway(app);
  assert.ok(built.routes >= PRODUCTION_STREAM_ROUTES.length);
  return { routes: PRODUCTION_STREAM_ROUTES.length, modules: built.runtimeModules, manifest: join(built.output, "gateway/src/routes.mjs") };
}
