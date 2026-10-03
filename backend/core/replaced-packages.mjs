import { resolve } from "node:path";
import { basenameKey } from "./bot-runtime-context.mjs";

/**
 * Whether a settings `packages` entry names a package this fork replaces with its own
 * bundled extension. A bare string entry and the `{ source }` form are equivalent, and
 * the version/tag may be pinned or omitted. The computer-use upstream is matched by its
 * known owner/repo forms only, so an unrelated package of the same name is left alone.
 */
export function isReplacedPackageSource(entry, replacedPackageNames) {
  const source =
    typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && typeof entry.source === "string"
        ? entry.source
        : "";
  const name = source.startsWith("npm:") ? source.slice("npm:".length) : source;
  const versionAt = name.lastIndexOf("@");
  if (replacedPackageNames.has(versionAt > 0 ? name.slice(0, versionAt) : name)) return true;
  return (
    replacedPackageNames.has("@injaneity/pi-computer-use") &&
    /^(?:git:github\.com\/injaneity\/pi-computer-use|https:\/\/github\.com\/injaneity\/pi-computer-use)(?:@[^/]+)?$/.test(source)
  );
}

/**
 * Bundled forks replace their upstream extension. `skipDiscovery` also drops the
 * npm package from the loader search, which avoids its module import entirely.
 * The retired MCP pair is always excluded. The user's settings.json is
 * never modified; the exclusion only applies inside this loader.
 */
export const FORK_REPLACED_EXTENSIONS = [
  { fork: "leafcode-subagents", upstream: "pi-subagents", skipDiscovery: false },
  { fork: "leafcode-intercom", upstream: "pi-intercom", skipDiscovery: true },
  { fork: "leafcode-computer-use", upstream: "@injaneity/pi-computer-use", skipDiscovery: true },
  { fork: "pi-anthropic-auth", upstream: "@gotgenes/pi-anthropic-auth", skipDiscovery: true },
];

/**
 * MCP extensions retired with the native cutover. The bundled adapter is deleted, so neither it nor
 * its upstream may load: a second MCP implementation would run next to the native runtime, and a
 * stale global copy of the fork would keep the old writers/auth store alive.
 */
export const RETIRED_MCP_EXTENSIONS = ["leafcode-mcp-adapter", "pi-mcp-adapter"];

/** npm packages excluded from discovery because a bundled fork replaces them, plus the retired MCP pair. */
export function replacedUpstreamPackages(bundledNames) {
  return new Set([
    ...FORK_REPLACED_EXTENSIONS.filter(
      (entry) => entry.skipDiscovery && bundledNames.has(entry.fork),
    ).map((entry) => entry.upstream),
    "pi-mcp-adapter",
  ]);
}

/** Keep one copy of every extension: drop replaced upstreams, retired MCP copies and stale duplicates. */
export function keepsLoadedExtension(extensionPath, bundled) {
  const key = basenameKey(extensionPath);
  const replacedByFork = FORK_REPLACED_EXTENSIONS.some(
    (entry) => bundled.names.has(entry.fork) && key === entry.upstream,
  );
  if (replacedByFork) return false;
  if (RETIRED_MCP_EXTENSIONS.includes(key)) return false;
  if (bundled.names.has("leafcode-computer-use") &&
      (key === "pi-computer-use" || /(?:^|[\\/])pi-computer-use(?:[\\/]|$)/i.test(extensionPath))) return false;
  // An entry such as leafcode-memory/src/index.ts is keyed "src"; match its package directory too.
  const copiesBundled = bundled.names.has(key) ||
    resolve(extensionPath).split(/[\\/]/).slice(0, -1).some((segment) => bundled.names.has(segment));
  return !copiesBundled || bundled.paths.has(resolve(extensionPath));
}