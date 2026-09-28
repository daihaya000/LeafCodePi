import { hostname } from "node:os";
import { readPushoverCredentials, readPushoverNotificationEnabled } from "@/lib/pushover-config";
import { paneTabIdForTask, type PaneTaskRef } from "@/lib/task-panes";

/** Server-side Pushover delivery. Never expose credentials to the browser. */
const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 5_000;

/** Use the same route as the WebUI tab; the host supplies its reachable bind address. */
function sessionUrl(task: PaneTaskRef, env: Record<string, string | undefined>): string | null {
  try {
    const configured = env.LEAFCODE_PI_PUBLIC_URL?.trim();
    const host = env.LEAFCODE_PI_HOST?.trim();
    const port = Number(env.LEAFCODE_PI_PORT || env.PORT || "3000");
    if (!configured && (!host || host === "0.0.0.0" || host === "::" || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
    const base = new URL(configured || `http://${host}:${port}/`);
    if (!(["http:", "https:"].includes(base.protocol)) || base.username || base.password) return null;
    const tabId = paneTabIdForTask(task);
    const route = tabId.startsWith("/") ? tabId : `/task/${encodeURIComponent(task.id)}`;
    const url = new URL(route, base.origin).href;
    return url.length <= 512 ? url : null;
  } catch {
    return null;
  }
}

export type CompletionContext = {
  error: string | null;
  manuallyAborted: boolean;
  recovering: boolean;
  goalLoopRunning: boolean;
  botNotificationsEnabled: boolean;
};

/** A settled SDK turn is not necessarily a finished user task. */
export function shouldNotifyPushoverCompletion(context: CompletionContext): boolean {
  return !context.error && !context.manuallyAborted && !context.recovering &&
    !context.goalLoopRunning && context.botNotificationsEnabled;
}

export async function notifyPushoverCompletion(
  taskTitle: string,
  options: { env?: Record<string, string | undefined>; send?: typeof fetch; title?: string; task?: PaneTaskRef } = {},
): Promise<boolean> {
  try {
    if (!readPushoverNotificationEnabled()) return false;
    const config = options.env ? {
      token: options.env.LEAFCODE_PI_PUSHOVER_TOKEN?.trim(),
      user: options.env.LEAFCODE_PI_PUSHOVER_USER?.trim(),
      device: options.env.LEAFCODE_PI_PUSHOVER_DEVICE?.trim(),
    } : await readPushoverCredentials();
    if (!config.token || !config.user) return false;

    // Never include a transcript, model output or error details in the notification.
    const link = options.task ? sessionUrl(options.task, options.env ?? process.env) : null;
    const message = `${Array.from(taskTitle.trim() || "LeafCodePi タスク").slice(0, 1024 - (link ? link.length + 1 : 0)).join("")}${link ? `\n${link}` : ""}`;
    const serverName = Array.from(hostname().trim()).slice(0, 64).join("");
    const subject = Array.from(options.title ?? "タスク完了").slice(0, 180).join("");
    const body = new URLSearchParams({
      token: config.token,
      user: config.user,
      title: ["LCP", serverName, subject].filter(Boolean).join(" "),
      message,
    });
    if (config.device) body.set("device", config.device);
    if (link) {
      body.set("url", link);
      body.set("url_title", "セッションを開く");
    }

    const response = await (options.send ?? fetch)(PUSHOVER_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
    });
    if (!response.ok) console.warn(`[pushover] notification failed (HTTP ${response.status})`);
    return response.ok;
  } catch {
    // Never log request bodies, credential values or provider responses.
    console.warn("[pushover] notification failed (storage, network or timeout)");
    return false;
  }
}
