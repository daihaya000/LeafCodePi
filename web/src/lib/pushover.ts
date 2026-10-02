import { hostname, networkInterfaces } from "node:os";
import { readPushoverCredentials, readPushoverNotificationEnabled } from "@/lib/pushover-config";
import { paneTabIdForTask, type PaneTaskRef } from "@/lib/task-panes";

/** Server-side Pushover delivery. Never expose credentials to the browser. */
const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 5_000;

type FindTailscaleIPv4 = () => string | null;

/** Mirrors the Host's lookup: prefer a NIC named Tailscale, otherwise any CGNAT 100.64/10 IPv4. */
export function findTailscaleIPv4(interfaces = networkInterfaces()): string | null {
  const isCgnat = (address: string) => {
    const [a, b, ...rest] = address.split(".").map(Number);
    return rest.length === 2 && a === 100 && b >= 64 && b <= 127;
  };
  const entries = Object.entries(interfaces);
  for (const preferName of [true, false]) {
    for (const [name, list] of entries) {
      if (preferName && !/tailscale/i.test(name)) continue;
      const match = list?.find((info) => !info.internal && String(info.family) !== "IPv6" && String(info.family) !== "6" && isCgnat(info.address));
      if (match) return match.address;
    }
  }
  return null;
}

/**
 * Use the same route as the WebUI tab. The WebUI child receives the resolved bind address, but the
 * Backend inherits the Host's raw `LEAFCODE_PI_HOST` (unset or `tailscale`), so resolve it here.
 */
function sessionUrl(task: PaneTaskRef, env: Record<string, string | undefined>, findTailscale: FindTailscaleIPv4): string | null {
  try {
    const configured = env.LEAFCODE_PI_PUBLIC_URL?.trim();
    const rawHost = env.LEAFCODE_PI_HOST?.trim();
    const host = !rawHost || rawHost.toLowerCase() === "tailscale" ? findTailscale() ?? undefined : rawHost;
    // Same default as the Host's DEFAULT_WEBUI_PORT; the Backend may not receive PORT at all.
    const port = Number(env.LEAFCODE_PI_PORT || env.PORT || "3010");
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
  options: {
    env?: Record<string, string | undefined>;
    send?: typeof fetch;
    title?: string;
    task?: PaneTaskRef;
    findTailscale?: FindTailscaleIPv4;
  } = {},
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
    const link = options.task ? sessionUrl(options.task, options.env ?? process.env, options.findTailscale ?? findTailscaleIPv4) : null;
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
