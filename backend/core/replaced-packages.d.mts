/**
 * True when a settings package entry names one of the replaced upstream packages.
 * Accepts the bare string and `{ source }` forms, with or without a pinned version.
 */
export function isReplacedPackageSource(entry: unknown, replacedPackageNames: ReadonlySet<string>): boolean;

/** MCP extensions retired with the native cutover; always excluded, even as stale copies. */
export const RETIRED_MCP_EXTENSIONS: ReadonlyArray<string>;

/** Bundled forks and the npm packages they replace. */
export const FORK_REPLACED_EXTENSIONS: ReadonlyArray<{
  fork: string;
  upstream: string;
  skipDiscovery: boolean;
}>;

/** Provider extensions registered directly by the repository's ModelRuntime. */
export const INTEGRATED_PROVIDER_EXTENSIONS: ReadonlyArray<string>;

/** npm packages excluded from discovery: bundled replacements, retired MCP and integrated providers. */
export function replacedUpstreamPackages(bundledNames: ReadonlySet<string>): Set<string>;

/** Keep one copy of every extension: drop replaced upstreams and stale bundled duplicates. */
export function keepsLoadedExtension(
  extensionPath: string,
  bundled: { names: ReadonlySet<string>; paths: ReadonlySet<string> },
): boolean;