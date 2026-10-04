import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BACKEND_CHILD_PROCESS_MESSAGE } from "../../shared/backend-child-process-message.mjs";
import { processStartKey } from "../../shared/process-identity.mjs";

function processStartKeyAsync(pid) {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToFileTimeUtc()`,
      ], { encoding: "utf8", timeout: 1_000, windowsHide: true, maxBuffer: 1_024 }, (error, stdout) => {
        const raw = String(stdout ?? "").trim();
        resolve(!error && raw ? `win:${raw}` : undefined);
      });
    });
  }
  if (process.platform === "darwin") {
    return new Promise((resolve) => {
      execFile("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 1_000, maxBuffer: 1_024,
      }, (error, stdout) => {
        const raw = String(stdout ?? "").trim();
        resolve(!error && raw ? `ps:${raw}` : undefined);
      });
    });
  }
  return processStartKey(pid);
}

function sendToHost(send, message) {
  return new Promise((resolve) => {
    try { send.call(process, message, (error) => resolve(!error)); }
    catch { resolve(false); }
  });
}

/** Report an owned Backend child to the supervising Host while its PID identity is still known. */
export async function registerBackendChildProcess(child, {
  send = process.send,
  getProcessStartKey = processStartKeyAsync,
} = {}) {
  const pid = child?.pid;
  if (typeof send !== "function" || !Number.isSafeInteger(pid)) return null;
  const alreadyClosed = child.exitCode !== null || child.signalCode !== null;

  const token = randomUUID();
  const message = (action, processKey = null) => ({
    type: BACKEND_CHILD_PROCESS_MESSAGE,
    action,
    token,
    pid,
    processKey,
  });
  let childClosed = alreadyClosed;
  const onClose = () => {
    childClosed = true;
    try { send.call(process, message("stopped")); } catch { /* The Host may already be shutting down. */ }
  };
  child.once("close", onClose);
  if (!(await sendToHost(send, message("started")))) {
    child.removeListener("close", onClose);
    throw new Error("Backend child process registration failed");
  }
  if (alreadyClosed) {
    onClose();
    return { token, pid };
  }
  if (childClosed || child.exitCode !== null || child.signalCode !== null) return { token, pid };

  let processKey = null;
  try { processKey = await getProcessStartKey(pid) ?? null; } catch { /* Host will fail closed without an identity. */ }
  if (childClosed || child.exitCode !== null || child.signalCode !== null) return { token, pid };
  if (!(await sendToHost(send, message("identity", processKey)))) {
    throw new Error("Backend child process identity registration failed");
  }
  return { token, pid };
}
