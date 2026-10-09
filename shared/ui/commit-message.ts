export type CommitFileInfo = {
  path: string;
  untracked: boolean;
};

/** Normalize Windows `\` separators so index-relative paths from any source parse the same. */
function toSlash(path: string): string {
  return path.replace(/\\/g, "/");
}

function basename(path: string): string {
  const normalized = toSlash(path);
  const i = normalized.lastIndexOf("/");
  return i >= 0 ? normalized.slice(i + 1) : normalized;
}

/** Longest shared directory prefix (segment-wise) across paths, "" if none. */
function commonDir(paths: string[]): string {
  if (paths.length === 0) return "";
  const dirs = paths.map((p) => {
    const normalized = toSlash(p);
    const i = normalized.lastIndexOf("/");
    return i >= 0 ? normalized.slice(0, i).split("/") : [];
  });
  const first = dirs[0];
  let end = first.length;
  for (const segs of dirs.slice(1)) {
    let k = 0;
    while (k < end && k < segs.length && segs[k] === first[k]) k += 1;
    end = k;
  }
  return first.slice(0, end).join("/");
}

/**
 * Deterministic Japanese commit-message suggestion from the set of changed files.
 * Empty when no files are provided.
 */
export function suggestCommitMessage(files: CommitFileInfo[]): string {
  if (files.length === 0) return "";
  const verb = files.every((f) => f.untracked) ? "Add" : "Update";

  if (files.length === 1) {
    return `${verb === "Add" ? "追加" : "更新"} ${basename(files[0].path)}`;
  }

  const dir = commonDir(files.map((f) => f.path));
  return dir
    ? `${dir} の${files.length}ファイルを${verb === "Add" ? "追加" : "更新"}`
    : `${files.length}ファイルを${verb === "Add" ? "追加" : "更新"}`;
}
