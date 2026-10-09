import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { createTaskConversationCommands } from "../../backend/core/task-conversation-command.mjs";
import { publicHostBuildInfo } from "../../shared/host-build-info-contract.mjs";
const exec = promisify(execFile);
/** Fixed commands only. No shell, credential prompt, arbitrary repo or stderr disclosure. */
async function runGit(repoRoot, args, timeoutMs) {
  try {
    const { stdout } = await exec("git", args, { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 1024 * 1024,
      encoding: "utf8", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });
    return { code: 0, stdout };
  } catch { return { code: 1, stdout: "" }; }
}
export function createHostBuildInfo({ repoRoot, dataDir, git = runGit }) {
  const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir, "host-build-info-command.json") });
  let updating = false, inFlightId;
  const unavailable = () => ({ commit: null, committedAt: null, latestCommit: null });
  async function latest(local) {
    try {
      const upstream = await git(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], 2000);
      if (upstream.code !== 0) return local;
      const name = upstream.stdout.trim(), index = name.indexOf("/");
      if (index <= 0 || index === name.length - 1) return local;
      const remote = name.slice(0, index), ref = `refs/heads/${name.slice(index + 1)}`;
      if (remote.startsWith("-")) return local;
      const reply = await git(repoRoot, ["ls-remote", "--heads", remote, ref], 5000);
      const target = reply.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(([, branch]) => branch === ref)?.[0];
      if (reply.code !== 0 || !target || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(target) || target === local) return local;
      const behind = await git(repoRoot, ["merge-base", "--is-ancestor", target, local], 2000);
      return behind.code === 0 ? local : target;
    } catch { return local; }
  }
  async function read() {
    try {
      const result = await git(repoRoot, ["log", "-1", "--format=%H%n%cI"], 2000);
      const [commit, committedAt] = result.stdout.trim().split(/\r?\n/);
      const body = publicHostBuildInfo({ commit, committedAt, latestCommit: commit }, 200);
      if (result.code !== 0 || !body) return { status: 503, body: unavailable() };
      return { status: 200, body: { ...body, latestCommit: await latest(commit) } };
    } catch { return { status: 503, body: unavailable() }; }
  }
  async function update(operationId) {
    // No response/cache/auto-restart is owned by Next. A durable receipt is admitted
    // before pull, so disconnect/restart/repeated ID can never repeat a Git update.
    if (updating) return { status: 409, body: { error: "Host update already in progress", operation: { id: operationId, execution: operationId === inFlightId ? "unknown" : "not-started" } } };
    updating = true; inFlightId = operationId;
    try {
      const response = await commands.run({ operationId, handler: async () => {
        const result = await git(repoRoot, ["pull", "--ff-only", "--no-edit"], 60000);
        if (result.code !== 0) return Response.json({ error: "Host git pull failed" }, { status: 500 });
        const info = await read();
        return Response.json(info.body, { status: info.status });
      } });
      const body = publicHostBuildInfo(await response.json(), response.status);
      return { status: body ? response.status : 503, body: body ?? { error: "Host update result unavailable" } };
    } finally { updating = false; inFlightId = undefined; }
  }
  return { read, update };
}
