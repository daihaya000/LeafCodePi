import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getProject, getTask } from "@/lib/store";
import { MAX_PROMPT_FILE_NAME_CHARS, MAX_PROMPT_FILE_TOTAL_BYTES } from "@/lib/prompt-images";

/**
 * 添付できるプロジェクト／作業フォルダー内ファイルの境界。
 *
 * 不変条件:
 * - ルートはストア（登録済みプロジェクト or タスク作業ディレクトリ）からのみ取り、クライアント
 *   からは相対パスしか受け取らない。絶対パス・`..`・制御文字は受け付けない。
 * - シンボリックリンクは一覧・読み込みとも拒否し、実体解決後も `path.relative` でルート内を再確認する。
 * - 読み込みは UTF-8 テキストのみ。上限は `prompt-images.ts` の合計上限（64KiB）に合わせる。
 *   送信時に却下されるサイズを選ばせないため。
 */

/** 依存・ビルド生成物は一覧が埋まるだけで実用上の価値がない。 */
const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules", ".next", "dist", "out", "coverage"]);

/** 1 フォルダーがこの件数を超えたら打ち切り、`truncated` で通知する。 */
export const MAX_WORKSPACE_ENTRIES = 1000;

export type WorkspaceEntry = {
  name: string;
  /** ルートからの `/` 区切り相対パス。 */
  path: string;
  kind: "dir" | "file";
  size?: number;
};

export type WorkspaceListing = {
  path: string;
  parent: string | null;
  entries: WorkspaceEntry[];
  truncated: boolean;
};

/** 読み込み結果。`name` は添付名として使える相対パス（長すぎる場合は末尾のみ残す）。 */
export type WorkspaceFile = {
  name: string;
  mimeType: string;
  size: number;
  data: string;
};

export type WorkspaceFailure = { ok: false; error: string; status: number };
export type WorkspaceRoot = { ok: true; root: string } | WorkspaceFailure;

/** プロジェクトは登録ルート、タスクはプロジェクトルート（なければ作業ディレクトリ）を返す。 */
export function resolveWorkspaceRoot(scope: {
  kind: "project" | "task";
  id: string;
}): WorkspaceRoot {
  if (scope.kind === "task") {
    const task = getTask(scope.id);
    if (!task) return { ok: false, error: "タスクが見つかりません", status: 404 };
    // Bot の workspace は Bot 専用の非公開領域で、ユーザーがファイルを選ぶ対象ではない。
    if (task.kind === "bot") {
      return { ok: false, error: "Botの作業フォルダーは対象外です", status: 403 };
    }
    if (task.projectId) {
      const project = getProject(task.projectId);
      if (!project) return { ok: false, error: "プロジェクトが見つかりません", status: 404 };
      if (project.archived) {
        return { ok: false, error: "アーカイブ済みのプロジェクトです", status: 409 };
      }
      return { ok: true, root: project.rootPath };
    }
    if (!task.directory.trim()) {
      return { ok: false, error: "タスクの作業フォルダーが見つかりません", status: 404 };
    }
    return { ok: true, root: task.directory };
  }
  const project = getProject(scope.id);
  if (!project) return { ok: false, error: "プロジェクトが見つかりません", status: 404 };
  if (project.archived) {
    return { ok: false, error: "アーカイブ済みのプロジェクトです", status: 409 };
  }
  return { ok: true, root: project.rootPath };
}

/** クライアント由来のパスを、正規化する前の生値で検証する。 */
function isUnsafePathInput(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(value)) return true;
  // 先頭の区切りを落とす正規化の前に弾く（絶対パスを黙って相対解釈しない）。
  if (isAbsolute(value)) return true;
  // Windows のドライブ相対（`C:foo`）は resolve() でカレントドライブへ飛ぶ。
  if (/^[A-Za-z]:/.test(value)) return true;
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

function hasExcludedSegment(relPath: string): boolean {
  return relPath
    .split(/[\\/]/)
    .some((segment) => EXCLUDED_DIR_NAMES.has(segment.toLowerCase()));
}

/** ルートからの相対パスを `/` 区切りへ正規化する（先頭・末尾の区切りは落とす）。 */
function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * 実体解決してルート内であることを確認する。シンボリックリンクは拒否する。
 * 検証後の `realPath` を読み書きに使うことで、検証と読み込みの間の差し替え窓を狭める。
 */
function resolveInRoot(
  root: string,
  relPath: string,
): { realPath: string; stats: Stats } | null {
  const target = resolve(root, relPath);
  let stats: Stats;
  try {
    stats = lstatSync(target);
  } catch {
    return null;
  }
  if (stats.isSymbolicLink()) return null;
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync.native(root);
    realPath = realpathSync.native(target);
  } catch {
    return null;
  }
  const child = relative(realRoot, realPath);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return null;
  return { realPath, stats };
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
  return left.name.localeCompare(right.name, "ja");
}

function parentOf(relDir: string): string | null {
  if (!relDir) return null;
  const index = relDir.lastIndexOf("/");
  return index < 0 ? "" : relDir.slice(0, index);
}

/** 添付名は相対パス。プロンプト側の 255 コードポイント上限に収まるよう先頭を省略する。 */
export function workspaceAttachmentName(relPath: string): string {
  const normalized = normalizeRelative(relPath);
  const chars = Array.from(normalized);
  if (chars.length <= MAX_PROMPT_FILE_NAME_CHARS) return normalized;
  return `…${chars.slice(chars.length - MAX_PROMPT_FILE_NAME_CHARS + 1).join("")}`;
}

export function listWorkspaceEntries(
  root: string,
  relDir: string,
): { ok: true; listing: WorkspaceListing } | WorkspaceFailure {
  if (isUnsafePathInput(relDir)) {
    return { ok: false, error: "パスが不正です", status: 400 };
  }
  const relativeDir = normalizeRelative(relDir);
  if (relativeDir && hasExcludedSegment(relativeDir)) {
    return { ok: false, error: "このフォルダーは対象外です", status: 403 };
  }
  const resolved = resolveInRoot(root, relativeDir);
  if (!resolved || !resolved.stats.isDirectory()) {
    return { ok: false, error: "フォルダーが見つかりません", status: 404 };
  }
  let dirents;
  try {
    dirents = readdirSync(resolved.realPath, { withFileTypes: true });
  } catch {
    return { ok: false, error: "フォルダーを読み込めません", status: 500 };
  }
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents) {
    // 一覧に出しても開けないシンボリックリンクは表示しない。
    if (dirent.isSymbolicLink()) continue;
    const isDir = dirent.isDirectory();
    if (!isDir && !dirent.isFile()) continue;
    if (isDir && EXCLUDED_DIR_NAMES.has(dirent.name.toLowerCase())) continue;
    const entryPath = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
    if (isDir) {
      entries.push({ name: dirent.name, path: entryPath, kind: "dir" });
      continue;
    }
    let size: number | undefined;
    try {
      size = statSync(resolve(resolved.realPath, dirent.name)).size;
    } catch {
      // 読めないファイルはサイズなしで一覧に残す（選択時に改めて失敗する）。
    }
    entries.push({ name: dirent.name, path: entryPath, kind: "file", ...(size === undefined ? {} : { size }) });
  }
  entries.sort(compareEntries);
  return {
    ok: true,
    listing: {
      path: relativeDir,
      parent: parentOf(relativeDir),
      entries: entries.slice(0, MAX_WORKSPACE_ENTRIES),
      truncated: entries.length > MAX_WORKSPACE_ENTRIES,
    },
  };
}

export function readWorkspaceFile(
  root: string,
  relPath: string,
): { ok: true; file: WorkspaceFile } | WorkspaceFailure {
  if (!relPath || isUnsafePathInput(relPath)) {
    return { ok: false, error: "パスが不正です", status: 400 };
  }
  const relativePath = normalizeRelative(relPath);
  if (hasExcludedSegment(relativePath)) {
    return { ok: false, error: "このファイルは対象外です", status: 403 };
  }
  const resolved = resolveInRoot(root, relativePath);
  if (!resolved || !resolved.stats.isFile()) {
    return { ok: false, error: "ファイルが見つかりません", status: 404 };
  }
  if (resolved.stats.size === 0) {
    return { ok: false, error: "空のファイルは添付できません", status: 400 };
  }
  // 巨大ファイルを読み込む前に弾く（読み込み後の再確認も行う）。
  if (resolved.stats.size > MAX_PROMPT_FILE_TOTAL_BYTES) {
    return { ok: false, error: fileSizeError(), status: 413 };
  }
  const bytes = readFileSync(resolved.realPath);
  if (bytes.length === 0) {
    return { ok: false, error: "空のファイルは添付できません", status: 400 };
  }
  if (bytes.length > MAX_PROMPT_FILE_TOTAL_BYTES) {
    return { ok: false, error: fileSizeError(), status: 413 };
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "UTF-8テキストのみ添付できます", status: 415 };
  }
  return {
    ok: true,
    file: {
      name: workspaceAttachmentName(relativePath),
      // 受け口は UTF-8 テキストしか通さないため、拡張子ごとの MIME 表は持たない。
      mimeType: "text/plain",
      size: bytes.length,
      data: bytes.toString("base64"),
    },
  };
}

function fileSizeError(): string {
  return `ファイルは${MAX_PROMPT_FILE_TOTAL_BYTES / 1024}KiBまでです`;
}
