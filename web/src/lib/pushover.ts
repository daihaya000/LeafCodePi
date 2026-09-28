/** Server-side Pushover delivery. Credentials are read from the host environment only. */
const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const PUSHOVER_TIMEOUT_MS = 5_000;

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
  options: { env?: Record<string, string | undefined>; send?: typeof fetch } = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const token = env.LEAFCODE_PI_PUSHOVER_TOKEN?.trim();
  const user = env.LEAFCODE_PI_PUSHOVER_USER?.trim();
  if (!token || !user) return false;

  // Send the task title only, never a transcript, model output or error details.
  const message = Array.from(taskTitle.trim() || "LeafCodePi タスク").slice(0, 1024).join("");
  const body = new URLSearchParams({ token, user, title: "LeafCodePi タスク完了", message });
  const device = env.LEAFCODE_PI_PUSHOVER_DEVICE?.trim();
  if (device) body.set("device", device);

  try {
    const response = await (options.send ?? fetch)(PUSHOVER_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(PUSHOVER_TIMEOUT_MS),
    });
    if (!response.ok) console.warn(`[pushover] notification failed (HTTP ${response.status})`);
    return response.ok;
  } catch {
    // Never log request bodies, credential values or provider responses.
    console.warn("[pushover] notification failed (network or timeout)");
    return false;
  }
}
