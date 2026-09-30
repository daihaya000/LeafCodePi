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