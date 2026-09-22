import { spawn } from "node:child_process";

/** Choose the OS file-manager command. Windows Explorer stays explorer.exe. */
export function explorerOpenCommand(platform, targetPath) {
  if (platform === "win32") return { command: "explorer.exe", args: [targetPath] };
  if (platform === "darwin") return { command: "open", args: [targetPath] };
  return { command: "xdg-open", args: [targetPath] };
}

export function openProjectInExplorer(targetPath, options = {}) {
  const spawnFn = options.spawn ?? spawn;
  const platform = options.platform ?? process.platform;
  const { command, args } = explorerOpenCommand(platform, targetPath);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, { detached: true, stdio: "ignore" });
    let settled = false;
    let settleTimer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      callback(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("spawn", () => {
      child.unref?.();
      // xdg-open may hand the path to the desktop and exit immediately. Give
      // it a short window to report a real failure without blocking on the
      // file manager/browser it launches.
      settleTimer = setTimeout(() => finish(resolve, { ok: true }), 100);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, { ok: true });
      } else {
        finish(
          reject,
          new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`),
        );
      }
    });
  });
}
