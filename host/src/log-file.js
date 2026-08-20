import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function formatLogLine({ ts, source, level, text }) {
  const stamp =
    typeof ts === "number" ? new Date(ts).toISOString() : new Date().toISOString();
  const body = String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\t/g, " ");
  return `${stamp}\t${source ?? "host"}\t${level ?? "log"}\t${body}`;
}

export function createLogFileWriter(dir, deps = {}) {
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const append = deps.appendFileSync ?? appendFileSync;
  const stat = deps.statSync ?? statSync;
  const rename = deps.renameSync ?? renameSync;
  const exists = deps.existsSync ?? existsSync;
  const unlink = deps.unlinkSync ?? unlinkSync;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  mkdir(dir, { recursive: true });
  const file = join(dir, "host.log");

  function rotateIfNeeded() {
    try {
      if (!exists(file)) return;
      if (stat(file).size < maxBytes) return;
      const rotated = `${file}.1`;
      if (exists(rotated)) unlink(rotated);
      rename(file, rotated);
    } catch {
      /* ignore */
    }
  }

  return {
    write(entry) {
      try {
        rotateIfNeeded();
        append(file, `${formatLogLine(entry)}\n`, "utf8");
      } catch {
        /* never take the host down */
      }
    },
  };
}
