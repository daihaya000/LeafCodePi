import { spawn as defaultSpawn, spawnSync as defaultSpawnSync } from "node:child_process";

export const GIT_PULL_TIMEOUT_MS = 120_000;

function currentCommitSync(repoRoot, env, spawnSync) {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_PULL_TIMEOUT_MS,
      windowsHide: true,
    });
    return result?.status === 0 ? result.stdout?.trim() || null : null;
  } catch {
    return null;
  }
}

function failureReason(result) {
  if (result?.error?.message) return result.error.message;
  if (result?.error) return String(result.error);
  if (result && "status" in result) return `git exited ${result.status ?? "unknown"}`;
  return "git pull did not complete";
}

async function resolveAfter(getAfter) {
  return await getAfter();
}

async function finishPull({ before, result, localChanges, getAfter, log, error }) {
  const output = [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
  if (output) log(output);

  if (result?.error || result?.status !== 0) {
    error(`Remote git pull failed; continuing with local sources (${failureReason(result)})`);
    return { ok: false, updated: false, localChanges };
  }
  const after = await resolveAfter(getAfter);
  const updated = !before || !after || before !== after;
  log(updated ? "Pulled updated sources from remote" : "Sources are already up to date");
  return { ok: true, updated, localChanges };
}

/**
 * Sync pull for callers that must stay synchronous (tests / inject spawnSync).
 * Prefer pullLatestSourcesAsync during restarts so the Host event loop stays responsive.
 */
export function pullLatestSources({
  repoRoot,
  env = process.env,
  spawnSync = defaultSpawnSync,
  log = () => {},
  error = () => {},
} = {}) {
  let result;
  let before;
  try {
    before = currentCommitSync(repoRoot, env, spawnSync);
    result = spawnSync("git", ["pull", "--ff-only"], {
      cwd: repoRoot,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_PULL_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (err) {
    error(`Remote git pull failed; continuing with local sources (${err instanceof Error ? err.message : String(err)})`);
    return { ok: false, updated: false };
  }

  const after = currentCommitSync(repoRoot, env, spawnSync);
  const output = [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
  if (output) log(output);
  if (result?.error || result?.status !== 0) {
    error(`Remote git pull failed; continuing with local sources (${failureReason(result)})`);
    return { ok: false, updated: false };
  }
  const updated = !before || !after || before !== after;
  log(updated ? "Pulled updated sources from remote" : "Sources are already up to date");
  return { ok: true, updated };
}

function spawnGit(spawnImpl, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawnImpl("git", args, {
        cwd,
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: "", error: err });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      settled = true;
      resolve({
        status: null,
        stdout,
        stderr,
        error: new Error(`git timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
    if (typeof child.stdout?.setEncoding === "function") child.stdout.setEncoding("utf8");
    if (typeof child.stderr?.setEncoding === "function") child.stderr.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error: err });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function currentCommitAsync(repoRoot, env, spawnImpl) {
  const result = await spawnGit(spawnImpl, ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    env,
    timeoutMs: GIT_PULL_TIMEOUT_MS,
  });
  return result.status === 0 ? result.stdout?.trim() || null : null;
}

async function hasLocalChangesAsync(repoRoot, env, spawnImpl) {
  const result = await spawnGit(spawnImpl, ["status", "--porcelain"], {
    cwd: repoRoot,
    env,
    timeoutMs: GIT_PULL_TIMEOUT_MS,
  });
  // If cleanliness cannot be verified, rebuild conservatively rather than reuse stale artifacts.
  return result.status !== 0 || Boolean(result.stdout?.trim());
}

/** Non-blocking pull so Host control / hang-watch keep running during restart. */
export async function pullLatestSourcesAsync({
  repoRoot,
  env = process.env,
  spawn = defaultSpawn,
  log = () => {},
  error = () => {},
} = {}) {
  let before;
  let result;
  let localChanges = true;
  try {
    localChanges = await hasLocalChangesAsync(repoRoot, env, spawn);
    before = await currentCommitAsync(repoRoot, env, spawn);
    result = await spawnGit(spawn, ["pull", "--ff-only"], {
      cwd: repoRoot,
      env,
      timeoutMs: GIT_PULL_TIMEOUT_MS,
    });
  } catch (err) {
    error(`Remote git pull failed; continuing with local sources (${err instanceof Error ? err.message : String(err)})`);
    return { ok: false, updated: false, localChanges };
  }

  return finishPull({
    before,
    result,
    localChanges,
    getAfter: () => currentCommitAsync(repoRoot, env, spawn),
    log,
    error,
  });
}
