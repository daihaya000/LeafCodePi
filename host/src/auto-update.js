import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKEND_PROTOCOL_HEADER, BACKEND_PROTOCOL_VERSION, BACKEND_RUNTIME_CONTROL_PATH } from "../../shared/backend-protocol.mjs";

const execFileAsync = promisify(execFile);
export const AUTO_UPDATE_IDLE_MS = 5 * 60_000;
export const AUTO_UPDATE_CHECK_MS = 5 * 60_000;

/** Never invoke a shell, prompt for credentials, stash, reset, or merge a moving ref. */
export function createUpdateRepository(repoRoot, run = async (args) => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    return stdout.trim();
  } catch {
    // Git stderr can contain a credential-bearing remote URL; never forward it to host.log.
    throw new Error(`git ${args[0]} failed or timed out`);
  }
}) {
  const clean = async () => (await run(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) === "";
  const head = () => run(["rev-parse", "--verify", "HEAD"]);
  // Capture the running source revision, not the first idle check several minutes later.
  const startedHead = head().catch(() => null);
  return {
    head,
    async check() {
      if (!await clean()) return null;
      const branch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (!branch) return null;
      const upstream = await run(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
      // Fetch only the configured upstream's remote. No checkout is modified here.
      const remote = await run(["config", "--get", `branch.${branch}.remote`]);
      if (!remote || remote === "." || remote.startsWith("-")) return null;
      await run(["fetch", "--quiet", "--no-tags", "--", remote]);
      const before = await head();
      const target = await run(["rev-parse", "--verify", upstream]);
      const counts = await run(["rev-list", "--left-right", "--count", `${before}...${target}`]);
      const match = /^(\d+)\s+(\d+)$/.exec(counts);
      if (!match || !await clean()) return null;
      if (Number(match[1]) === 0 && Number(match[2]) > 0) return { before, target, branch };
      // Also activate already-committed local updates (including a previous cancelled handoff).
      if (Number(match[2]) === 0 && await startedHead && before !== await startedHead) {
        return { before, target: before, branch };
      }
      return null;
    },
    async verify(candidate) {
      return await head() === candidate.target
        && await run(["symbolic-ref", "--quiet", "--short", "HEAD"]) === candidate.branch && await clean();
    },
    async apply(candidate) {
      if (!await clean() || await head() !== candidate.before
        || await run(["symbolic-ref", "--quiet", "--short", "HEAD"]) !== candidate.branch) return false;
      await run(["merge", "--ff-only", "--no-edit", candidate.target]);
      return await head() === candidate.target && await clean();
    },
  };
}

/** Separate from manual recovery: unavailable/old Backend state is NEVER safe for auto-update. */
export async function autoUpdateRuntimeRequest({ baseUrl, token, action, fetchImpl = fetch }) {
  if (!baseUrl || !token) return null;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${BACKEND_RUNTIME_CONTROL_PATH}${action ? "" : "?autoUpdate=1"}`, {
      method: action ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, [BACKEND_PROTOCOL_HEADER]: String(BACKEND_PROTOCOL_VERSION), "content-type": "application/json" },
      ...(action ? { body: JSON.stringify({ action }) } : {}),
      cache: "no-store", signal: AbortSignal.timeout(3000),
    });
    if (!response.ok || response.headers.get(BACKEND_PROTOCOL_HEADER) !== String(BACKEND_PROTOCOL_VERSION)) return null;
    const body = await response.json();
    return action ? body.result : body.autoUpdate;
  } catch { return null; }
}

export function runtimeIsIdle(state) {
  return state?.supported === true && state.busy === false;
}

/** Host-owned single flight. Activity from every browser resets the same idle window. */
export function createAutoUpdater({ repository, readRuntime, prepareRuntime, releaseRuntime, restart,
  available = () => true, claim = () => true, release = () => {}, now = Date.now, log = () => {}, error = () => {},
  idleMs = AUTO_UPDATE_IDLE_MS, checkMs = AUTO_UPDATE_CHECK_MS }) {
  let lastActivity = now();
  let nextCheck = now() + checkMs;
  let inFlight = false;
  let prepared = false;
  let claimed = false;
  const idle = () => available() && now() - lastActivity >= idleMs;
  return {
    activity() { lastActivity = now(); },
    async tick() {
      if (inFlight || now() < nextCheck || !idle()) return;
      inFlight = true;
      nextCheck = now() + checkMs;
      try {
        if (!runtimeIsIdle(await readRuntime()) || !idle()) return;
        const candidate = await repository.check();
        if (!candidate || !idle()) return;
        claimed = claim();
        if (!claimed) return;
        // Atomically recheck work and refuse new prompts while Git and restart hand off.
        // Even a lost response may have acquired the Backend lease; always try to release it.
        prepared = true;
        if ((await prepareRuntime())?.prepared !== true || !idle()) return;
        if (!await repository.apply(candidate) || !idle()) return;
        // Renew the short runtime lease after Git; if it expired and work started, defer.
        if ((await prepareRuntime())?.prepared !== true || !idle()) return;
        if (!runtimeIsIdle(await readRuntime()) || !idle()) return;
        // A user/editor can change the tree while Backend probes await; validate the exact
        // commit, branch and clean worktree again at the restart boundary.
        if (!await repository.verify(candidate) || !idle()) return;
        log(`LCP auto-update: ${candidate.before.slice(0, 12)} -> ${candidate.target.slice(0, 12)}; rebuilding and restarting`);
        await restart();
      } catch (err) {
        error(`LCP auto-update deferred: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        try {
          if (prepared) await releaseRuntime();
        } catch { /* The expiring Backend lease recovers if release delivery fails. */ }
        finally {
          prepared = false;
          if (claimed) release();
          claimed = false;
          inFlight = false;
          // Long network/Git failures must not turn the five-minute retry into a hot loop.
          nextCheck = now() + checkMs;
        }
      }
    },
  };
}
