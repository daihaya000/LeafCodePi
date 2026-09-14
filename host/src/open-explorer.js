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
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref?.();
      resolve({ ok: true });
    });
  });
}
