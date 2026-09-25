import { spawnSync as defaultSpawnSync } from "node:child_process";

export const GIT_PULL_TIMEOUT_MS = 120_000;

function currentCommit(repoRoot, env, spawnSync) {
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

/** Pull the tracked sources without making restart depend on network success. */
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
    before = currentCommit(repoRoot, env, spawnSync);
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

  const output = [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
  if (output) log(output);

  if (result?.error || result?.status !== 0) {
    error(`Remote git pull failed; continuing with local sources (${failureReason(result)})`);
    return { ok: false, updated: false };
  }
  const after = currentCommit(repoRoot, env, spawnSync);
  const updated = !before || !after || before !== after;
  log(updated ? "Pulled updated sources from remote" : "Sources are already up to date");
  return { ok: true, updated };
}
