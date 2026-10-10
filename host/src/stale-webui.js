import { readlinkSync } from "node:fs";
import { relative, resolve } from "node:path";

function processCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Stop WebUI servers orphaned by an earlier host that died without cleanup
 * (SIGKILL, a crash, a closed terminal). The WebUI runs in its own process
 * group, so it survives its host and keeps the port, failing every later start
 * with EADDRINUSE. Only listeners whose working directory is one of this
 * install's WebUI project directories are touched; anything else on the port is
 * left alone. Linux only: other platforms have no /proc to verify ownership.
 * @param {{
 *   port: number,
 *   projectDirs: string[],
 *   generationRoot?: string,
 *   getListeningPids: (port: number) => number[],
 *   stopProcessTreeGracefully: (input: { pid: number }) => Promise<string>,
 *   platform?: string,
 *   selfPid?: number,
 *   excludePids?: number[],
 *   cwdOf?: (pid: number) => string | null,
 *   log?: (message: string) => void,
 * }} input
 * @returns {Promise<number[]>} PIDs that were stopped.
 */
export async function stopOrphanedWebUi(input) {
  if ((input.platform ?? process.platform) !== "linux") return [];
  const dirs = new Set(input.projectDirs.map((dir) => resolve(dir)));
  const skip = new Set([input.selfPid ?? process.pid, ...(input.excludePids ?? [])]);
  const cwdOf = input.cwdOf ?? processCwd;
  const stopped = [];
  for (const pid of new Set(input.getListeningPids(input.port))) {
    if (skip.has(pid)) continue;
    const cwd = cwdOf(pid);
    const generationCwd = cwd && input.generationRoot
      ? relative(resolve(input.generationRoot, "generations"), resolve(cwd)).replaceAll("\\", "/") : "";
    const ownGeneration = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/gateway$/.test(generationCwd);
    if (!cwd || (!dirs.has(resolve(cwd)) && !ownGeneration)) continue;
    input.log?.(`Stopping orphaned WebUI (PID ${pid}) holding port ${input.port}`);
    await input.stopProcessTreeGracefully({ pid });
    stopped.push(pid);
  }
  return stopped;
}
