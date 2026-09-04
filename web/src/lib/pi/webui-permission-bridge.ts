import { randomUUID } from "node:crypto";

export type WebUiPermissionRequest = {
  id: string;
  sessionId: string;
  command: string;
  labels: string[];
  message: string;
};

type WebUiPermissionHandler = (request: WebUiPermissionRequest) => Promise<boolean | null>;

/** Must match extensions/leafcode-permission-gate/webui-bridge.ts */
const GLOBAL_KEY = "__leafcodeWebUiPermissionHandler" as const;

function readHandler(): WebUiPermissionHandler | null {
  return (globalThis as typeof globalThis & { [GLOBAL_KEY]?: WebUiPermissionHandler | null })[GLOBAL_KEY] ?? null;
}

function writeHandler(next: WebUiPermissionHandler | null): void {
  (globalThis as typeof globalThis & { [GLOBAL_KEY]?: WebUiPermissionHandler | null })[GLOBAL_KEY] = next;
}

/** Harness registers a handler that routes prompts to the WebUI (SSE + API). */
export function registerWebUiPermissionHandler(next: WebUiPermissionHandler | null): void {
  writeHandler(next);
}

/** Returns null when no WebUI handler is registered (caller should fall back or block). */
export async function requestWebUiPermission(input: {
  sessionId: string;
  command: string;
  labels: string[];
  message: string;
}): Promise<boolean | null> {
  if (!input.sessionId) return null;
  const handler = readHandler();
  if (!handler) return null;
  return handler({
    id: randomUUID(),
    sessionId: input.sessionId,
    command: input.command,
    labels: input.labels,
    message: input.message,
  });
}
