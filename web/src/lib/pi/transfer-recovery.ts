import { createHash, randomUUID } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  chmodSync, closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { dataDir } from "@/lib/paths";

const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const RECOVERY_DIRECTORY = "settings-transfer-recovery";
const activeTransactions = new Set<string>();

type FileSnapshot = { path: string; content: string | null; mode: number };
type RecoveryJournal = { format: "leafcode-pi-transfer-recovery"; version: 1; files: FileSnapshot[]; checksum: string };

function checksum(files: FileSnapshot[]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

/** 復旧または保全ファイル削除に失敗した場合、適用状態とスナップショットの場所を返す。 */
export class TransferRecoveryError extends Error {
  constructor(readonly recoveryPath: string, message = "設定の自動復旧に失敗しました", readonly applied = false) {
    super(`${message}。保全ファイル: ${recoveryPath}`);
  }
}

function snapshot(paths: readonly string[]): FileSnapshot[] {
  let total = 0;
  return [...new Set(paths)].map((path) => {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path, content: null, mode: 0o600 };
      }
      throw error;
    }
    if (!stat.isFile()) throw new Error("転送先に通常のファイルではない項目があります");
    total += stat.size;
    if (total > MAX_SNAPSHOT_BYTES) throw new Error("復旧用スナップショットが大きすぎます");
    return { path, content: readFileSync(path).toString("base64"), mode: stat.mode & 0o777 };
  });
}

function createJournal(files: FileSnapshot[]): string {
  const directory = join(dataDir(), RECOVERY_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.json`);
  const fd = openSync(path, "wx", 0o600);
  try {
    const journal: RecoveryJournal = { format: "leafcode-pi-transfer-recovery", version: 1, files, checksum: checksum(files) };
    writeFileSync(fd, JSON.stringify(journal), "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
  return path;
}

/** SDK / CodexBar と同じ auth.json.lock を使用する。 */
export async function withAuthFileLock<T>(path: string, action: () => T | Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("認証ファイルのロックを取得できません");
      await delay(25);
    }
  }
  try { return await action(); }
  finally { await rmdir(lock); }
}

function restoreOne(entry: FileSnapshot): void {
  if (entry.content === null) {
    rmSync(entry.path, { force: true });
    return;
  }
  mkdirSync(dirname(entry.path), { recursive: true, mode: 0o700 });
  const tmp = `${entry.path}.${randomUUID()}.transfer-restore.tmp`;
  try {
    writeFileSync(tmp, Buffer.from(entry.content, "base64"), { flag: "wx", mode: entry.mode });
    try { renameSync(tmp, entry.path); }
    catch { copyFileSync(tmp, entry.path); }
    if (process.platform !== "win32") chmodSync(entry.path, entry.mode);
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function restoreAll(files: FileSnapshot[]): Promise<void> {
  const errors: unknown[] = [];
  for (const entry of [...files].reverse()) {
    try {
      if (basename(entry.path) === "auth.json") await withAuthFileLock(entry.path, () => restoreOne(entry));
      else restoreOne(entry);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error(`${errors.length}件の転送先を復旧できませんでした`);
}

/** 異常終了後も、内容を返さず保全ファイルのIDだけ列挙する。 */
export function listTransferRecoveries(): string[] {
  const directory = join(dataDir(), RECOVERY_DIRECTORY);
  let entries: Dirent[];
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -5));
}

/** 復旧が不要と確認した保全ファイルだけを削除する。 */
export function discardTransferRecoveryFile(id: string): void {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("保全ファイルIDが不正です");
  if (activeTransactions.has(dataDir())) {
    throw Object.assign(new Error("別のインポート処理が進行中です"), { status: 409 });
  }
  const path = join(dataDir(), RECOVERY_DIRECTORY, `${id}.json`);
  if (!lstatSync(path).isFile()) throw new Error("保全ファイルが通常のファイルではありません");
  rmSync(path);
}

/** 管理者が I/O 障害を直した後の再復旧用。保全ファイルは信頼できるローカルファイルに限る。 */
export async function restoreTransferRecoveryFile(journalPath: string): Promise<void> {
  const directory = resolve(dataDir(), RECOVERY_DIRECTORY);
  if (dirname(resolve(journalPath)) !== directory || !/^[0-9a-f-]{36}\.json$/.test(basename(journalPath))) {
    throw new Error("保全ファイルの場所が不正です");
  }
  const journalStat = lstatSync(journalPath);
  if (!journalStat.isFile() || journalStat.size > MAX_SNAPSHOT_BYTES * 1.5) {
    throw new Error("保全ファイルの形式またはサイズが不正です");
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as RecoveryJournal;
  if (journal.format !== "leafcode-pi-transfer-recovery" || journal.version !== 1 ||
    !Array.isArray(journal.files) || journal.files.length > 1_000 ||
    journal.files.some((entry) => !entry || typeof entry.path !== "string" || !isAbsolute(entry.path) ||
      (entry.content !== null && (typeof entry.content !== "string" || Buffer.from(entry.content, "base64").toString("base64") !== entry.content)) ||
      !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) ||
    journal.checksum !== checksum(journal.files)
  ) throw new Error("保全ファイルの形式が不正です");
  const root = dataDir();
  if (activeTransactions.has(root)) {
    throw Object.assign(new Error("別のインポート処理が進行中です"), { status: 409 });
  }
  activeTransactions.add(root);
  try {
    await restoreAll(journal.files);
    rmSync(journalPath);
  } finally {
    activeTransactions.delete(root);
  }
}

/** 書込失敗なら変更済みファイルを元のバイト列へ戻す。復旧不能なら0600の保全ファイルを残す。 */
export async function withTransferRecovery<T>(
  paths: readonly string[],
  action: () => Promise<T>,
  onRestored?: () => void,
  options?: { completedLabel?: string },
): Promise<T> {
  if (!paths.length) return action();
  const root = dataDir();
  if (activeTransactions.has(root)) {
    throw Object.assign(new Error("別のインポート処理が進行中です"), { status: 409 });
  }
  activeTransactions.add(root);
  try {
    const files = snapshot(paths);
    const journalPath = createJournal(files);
    let result: T;
    try {
      result = await action();
    } catch (error) {
      try {
        await restoreAll(files);
        onRestored?.();
      } catch {
        throw new TransferRecoveryError(journalPath);
      }
      try { rmSync(journalPath); }
      catch { throw new TransferRecoveryError(journalPath, "設定は元に戻しましたが、保全ファイルを削除できませんでした"); }
      throw error;
    }
    // 成功後は平文の保全ファイルを残さない。削除失敗でも適用済みと明示する。
    try { rmSync(journalPath, { force: true }); }
    catch { throw new TransferRecoveryError(journalPath, `${options?.completedLabel ?? "インポート"}は完了しましたが、保全ファイルを削除できませんでした`, true); }
    return result;
  } finally {
    activeTransactions.delete(root);
  }
}
