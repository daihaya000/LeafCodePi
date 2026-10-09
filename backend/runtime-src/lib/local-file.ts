import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { browseAllowedRoots, resolveAllowedBrowsePath } from "@/lib/browse-paths";
import { getProject, getTask } from "@/lib/store";

export type LocalFileFailure = { ok: false; status: number; error: string };
/** Shared image/media boundary; never canonicalize a network or lexically untrusted path. */
export function resolveTaskLocalFile(taskId: string, requestedPath: string): { ok: true; path: string } | LocalFileFailure {
  assertConfigurationOwner();
  if (!requestedPath || requestedPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(requestedPath)) {
    return { ok: false, status: 400, error: "ファイルパスが不正です" };
  }
  if (/^[\\/]{2}/.test(requestedPath) || /^[A-Za-z]:[^\\/]/.test(requestedPath) ||
    (/^[A-Za-z][A-Za-z\d+.-]*:/.test(requestedPath) && !/^[A-Za-z]:[\\/]/.test(requestedPath))) {
    return { ok: false, status: 400, error: "URL・ネットワーク・ドライブ相対パスは表示できません" };
  }
  const task = getTask(taskId);
  if (!task) return { ok: false, status: 404, error: "タスクが見つかりません" };
  const project = task.projectId ? getProject(task.projectId) : undefined;
  const cwd = project?.rootPath || task.directory;
  if (!cwd) return { ok: false, status: 404, error: "作業フォルダーが見つかりません" };
  const expanded = requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
    ? resolve(homedir(), requestedPath.slice(2)) : requestedPath;
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const roots = [...new Set([...browseAllowedRoots(), cwd, homedir(), tmpdir()])];
  const path = resolveAllowedBrowsePath(target, { roots });
  if (!path || /^[\\/]{2}/.test(path)) {
    return { ok: false, status: 403, error: "この場所のファイルは表示できません" };
  }
  return { ok: true, path };
}
