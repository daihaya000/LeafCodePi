/**
 * True when a settings package entry names one of the replaced upstream packages.
 * Accepts the bare string and `{ source }` forms, with or without a pinned version.
 */
export function isReplacedPackageSource(entry: unknown, replacedPackageNames: ReadonlySet<string>): boolean;