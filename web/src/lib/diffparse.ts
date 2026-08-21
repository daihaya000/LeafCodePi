import type { DiffFile, DiffHunk, DiffLine } from "@/lib/types";

/** Parse `git diff --no-color` unified output into per-file structures. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text.trim()) return files;

  const blocks = text.split(/^diff --git /m).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const file: DiffFile = {
      path: "",
      additions: 0,
      deletions: 0,
      binary: false,
      untracked: false,
      hunks: [],
    };

    // First line: `a/old b/new` (paths may be quoted)
    const headerMatch = /^"?a\/(.+?)"? "?b\/(.+?)"?$/.exec(lines[0] ?? "");
    if (headerMatch) {
      file.path = headerMatch[2];
      if (headerMatch[1] !== headerMatch[2]) file.oldPath = headerMatch[1];
    }

    let hunk: DiffHunk | null = null;
    for (const line of lines.slice(1)) {
      // A new hunk header. Check first so `@@` is never mistaken for content.
      if (line.startsWith("@@")) {
        hunk = { header: line, lines: [] };
        file.hunks.push(hunk);
        continue;
      }
      // File-level headers (`---`/`+++`/`Binary files`) only appear before the
      // first hunk. Once inside a hunk, a diff line such as `--- foo` is the
      // DELETION of a line whose content is `-- foo`, and `+++ foo` the ADDITION
      // of `++ foo` — they must be treated as content, not headers.
      if (hunk === null) {
        if (line.startsWith("Binary files ")) {
          file.binary = true;
          continue;
        }
        if (line.startsWith("+++ ")) {
          const p = line.slice(4).trim();
          if (p !== "/dev/null") file.path = p.replace(/^"?b\//, "").replace(/"$/, "");
          continue;
        }
        if (line.startsWith("--- ")) {
          const p = line.slice(4).trim();
          if (p !== "/dev/null" && !file.path) {
            file.path = p.replace(/^"?a\//, "").replace(/"$/, "");
          }
          continue;
        }
        // Other pre-hunk metadata (index, mode, rename…) — skip.
        continue;
      }
      if (line.startsWith("+")) {
        hunk.lines.push({ t: "+", text: line.slice(1) });
        file.additions += 1;
      } else if (line.startsWith("-")) {
        hunk.lines.push({ t: "-", text: line.slice(1) });
        file.deletions += 1;
      } else if (line.startsWith(" ") || line === "") {
        hunk.lines.push({ t: " ", text: line.slice(1) });
      }
      // lines starting with "\" (no newline marker) are skipped
    }

    if (file.path) files.push(file);
  }
  return files;
}

/** Synthesize an all-added hunk for an untracked file's content. */
export function untrackedHunk(content: string, maxLines = 400): DiffHunk {
  const all = content.split(/\r?\n/);
  // A file ending in a newline yields a trailing "" element; dropping it avoids
  // a phantom empty "+" line and an off-by-one added-line count.
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const shown = all.slice(0, maxLines);
  const lines: DiffLine[] = shown.map((text) => ({ t: "+" as const, text }));
  if (all.length > maxLines) {
    lines.push({ t: " ", text: `… (${all.length - maxLines} more lines)` });
  }
  return { header: `@@ -0,0 +1,${all.length} @@`, lines };
}
