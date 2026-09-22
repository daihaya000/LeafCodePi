import { spawnSync as defaultSpawnSync } from "node:child_process";

export const GIT_PULL_TIMEOUT_MS = 120_000;

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
  try {
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
    return false;
  }

  const output = [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
  if (output) log(output);

  if (result?.error || result?.status !== 0) {
    error(`Remote git pull failed; continuing with local sources (${failureReason(result)})`);
    return false;
  }
  log("Pulled latest sources from remote");
  return true;
}
