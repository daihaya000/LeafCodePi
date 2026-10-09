export const HOST_BUILD_INFO_PATH = "/build-info";
export const HOST_BUILD_INFO_HEADER = "x-leafcode-build-info";
export const HOST_BUILD_OPERATION_HEADER = "x-leafcode-build-operation";
export const HOST_BUILD_INFO_BODY_LIMIT = 512;
const commit = value => value === null || typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
export function publicHostBuildInfo(value, status) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let out;
  if (Object.hasOwn(value, "commit")) {
    if (!commit(value.commit) || !commit(value.latestCommit) || !(value.committedAt === null || typeof value.committedAt === "string" && value.committedAt.length > 0 && value.committedAt.length <= 80 && !/[\r\n]/.test(value.committedAt))) return null;
    out = { commit: value.commit, committedAt: value.committedAt, latestCommit: value.latestCommit };
  } else if (status >= 400 && typeof value.error === "string") out = { error: "HostのGit情報・更新処理を完了できません" };
  else return null;
  const operation = value.operation;
  if (operation !== undefined) {
    if (!operation || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation.id) || !["not-started", "complete", "unknown"].includes(operation.execution)) return null;
    out.operation = { id: operation.id, execution: operation.execution };
  }
  return out;
}
