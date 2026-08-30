import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";

export class WorkspaceMoveError extends Error {
  readonly status = 400;
}

export type PreparedWorkspaceMove = {
  /** Remove the copied destination and restore an existing empty destination. */
  rollback: () => Promise<void>;
  /** Remove the original workspace after the task record has switched. */
  finalize: () => Promise<void>;
};

function sameOrDescendant(path: string, parent: string): boolean {
  const child = resolve(path).toLowerCase();
  const root = resolve(parent).toLowerCase();
  return child === root || child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function readDirectory(path: string): Promise<Dirent[] | null> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

/**
 * Copy a workspace into an empty destination while keeping the source intact.
 * The caller finalizes the move only after all durable metadata has been updated.
 */
export async function prepareWorkspaceMove(
  sourcePath: string,
  destinationPath: string,
): Promise<PreparedWorkspaceMove> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (sameOrDescendant(source, destination) || sameOrDescendant(destination, source)) {
    throw new WorkspaceMoveError("移動元と移動先を入れ子にはできません");
  }

  let sourceInfo;
  try {
    sourceInfo = await stat(source);
  } catch {
    throw new WorkspaceMoveError("移動元の作業フォルダーが見つかりません");
  }
  if (!sourceInfo.isDirectory()) throw new WorkspaceMoveError("移動元がフォルダーではありません");

  let parentInfo;
  try {
    parentInfo = await stat(dirname(destination));
  } catch {
    throw new WorkspaceMoveError("移動先の親フォルダーが見つかりません");
  }
  if (!parentInfo.isDirectory()) throw new WorkspaceMoveError("移動先の親がフォルダーではありません");

  let destinationExists = false;
  try {
    const destinationInfo = await stat(destination);
    destinationExists = true;
    if (!destinationInfo.isDirectory()) throw new WorkspaceMoveError("移動先がフォルダーではありません");
    const entries = await readDirectory(destination);
    if (!entries) throw new WorkspaceMoveError("移動先を読み取れません");
    if (entries.length > 0) throw new WorkspaceMoveError("移動先は空のフォルダーを指定してください");
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
    // A missing destination is allowed; its parent was already validated.
  }

  const staging = resolve(dirname(destination), `.leafcodepi-promotion-${randomUUID()}`);
  const backup = destinationExists
    ? resolve(dirname(destination), `.leafcodepi-promotion-backup-${randomUUID()}`)
    : null;
  let destinationMoved = false;
  let backupMoved = false;
  try {
    await mkdir(staging);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await cp(resolve(source, entry.name), resolve(staging, entry.name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    if (backup) {
      await rename(destination, backup);
      backupMoved = true;
    }
    await rename(staging, destination);
    destinationMoved = true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (destinationMoved) {
      await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    }
    if (backupMoved && backup && !existsSync(destination)) {
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }

  let closed = false;
  return {
    async rollback() {
      if (closed) return;
      closed = true;
      await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      if (backupMoved && backup && !existsSync(destination)) {
        await rename(backup, destination);
      }
      await rm(staging, { recursive: true, force: true });
    },
    async finalize() {
      if (closed) return;
      closed = true;
      let sourceError: unknown;
      try {
        await rm(source, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        sourceError = error;
      }
      if (backup) await rm(backup, { recursive: true, force: true });
      if (sourceError) throw sourceError;
    },
  };
}
