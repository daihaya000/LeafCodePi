/** Display text only; never resolves, reads, creates or validates a filesystem path. */
export function displayLeafcodePiDataPath(
  relative = "",
  platform = process.platform,
  dataDirOverride = process.env.LEAFCODE_PI_DATA_DIR,
) {
  const override = dataDirOverride?.trim();
  const separator = platform === "win32" ? "\\" : "/";
  const rel = relative.replace(/^[\\/]+/, "").replaceAll(/[\\/]/g, separator);
  if (override) {
    const root = override.replace(/[\\/]+$/, "");
    return rel ? `${root}${separator}${rel}` : root;
  }
  const root = platform === "win32" ? "%APPDATA%\\leafcode-pi" : "~/.leafcode-pi";
  return rel ? `${root}${separator}${rel}` : root;
}
