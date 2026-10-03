import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
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
  const chmod = deps.chmodSync ?? chmodSync;
  const platform = deps.platform ?? process.platform;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "host.log");
  if (platform !== "win32") {
    try {
      chmod(dir, 0o700);
      if (exists(file)) chmod(file, 0o600);
    } catch {
      /* logging remains best effort */
    }
  }

  // Track the size in memory and re-sync with the disk occasionally, instead of a stat per line.
  const RESYNC_EVERY_WRITES = 64;
  // 追記後に強制で取り直す間隔。別プロセスの追記を tracked size に取り込み、
  // 回転が永遠に起きない（あるいは逆に早期に回転する）ことを避ける。
  const FORCE_RESYNC_EVERY_WRITES = 256;
  let knownSize = null;
  let writesSinceSync = 0;

  function rotateIfNeeded() {
    try {
      if (knownSize === null || writesSinceSync >= RESYNC_EVERY_WRITES) {
        knownSize = exists(file) ? stat(file).size : 0;
        writesSinceSync = 0;
      }
      if (knownSize < maxBytes) return;
      // Keep two generations: with only `.1` the previous archive is deleted on the
      // next rotation, so a reader that opened the rotated file mid-rotation can find
      // it already unlinked. `.2` keeps the older copy around long enough to finish.
      const oldest = `${file}.2`;
      const previous = `${file}.1`;
      if (exists(oldest)) unlink(oldest);
      if (exists(previous)) rename(previous, oldest);
      rename(file, previous);
      knownSize = 0;
      writesSinceSync = 0;
    } catch {
      /* ignore */
    }
  }

  return {
    write(entry) {
      try {
        rotateIfNeeded();
        const line = `${formatLogLine(entry)}\n`;
        append(file, line, { encoding: "utf8", mode: 0o600 });
        if (knownSize !== null) knownSize += Buffer.byteLength(line, "utf8");
        writesSinceSync += 1;
        // 別プロセスが同じファイルへ追記している可能性があるので、まれにディスク上の
        // サイズを取り直す。tracked size だけでは他プロセスの追記分を加算できず、
        // 回転も起きないまま増える。
        if (writesSinceSync % FORCE_RESYNC_EVERY_WRITES === 0) {
          try {
            knownSize = exists(file) ? stat(file).size : 0;
          } catch {
            /* fall back to the tracked size */
          }
        }
      } catch {
        /* never take the host down */
      }
    },
  };
}
