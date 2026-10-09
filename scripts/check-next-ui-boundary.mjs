import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNextTransportBoundary } from "./check-next-transport-boundary.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
export function nextUiRoots(root = ROOT) {
  const web = resolve(root, "web/src"), roots = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) { if (realpathSync(path) !== path) throw Error("UI directories cannot redirect to owner code"); walk(path); continue; }
      if (!/\.[jt]sx?$/.test(path) || /\.test\.[jt]sx?$/.test(path)) continue;
      const source = readFileSync(path, "utf8"), rel = relative(web, path).replaceAll("\\", "/");
      if (/^app\/(?:.*\/)?(page|layout|loading|error|not-found|global-error|template|default)\.[jt]sx?$/.test(rel) || /^\s*["']use client["']/.test(source)) roots.push("web/src/" + rel);
    }
  }
  walk(web); return roots.sort();
}
export function checkNextUiBoundary(root = ROOT, ts) { return checkNextTransportBoundary(root, ts, nextUiRoots(root), "ui"); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log("Next UI boundary:", checkNextUiBoundary()); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
