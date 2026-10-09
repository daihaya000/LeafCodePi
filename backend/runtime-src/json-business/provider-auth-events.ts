import { getActiveProviderLogin, subscribeProviderLogin } from "../lib/pi/harness";
import { createProviderLoginStream } from "./provider-login-stream";
import type { JsonBusinessInput } from "./index";
/** Only the runtime owner selects/replays login state. Disconnect never cancels authentication. */
export function openProviderLoginEvents(input: JsonBusinessInput): Response {
  const sessionId = new URL(input.url).searchParams.get("sessionId")?.trim() ?? "";
  return createProviderLoginStream(input.signal ?? new AbortController().signal, input.route, sessionId, {
    active: getActiveProviderLogin, subscribe: subscribeProviderLogin,
  });
}
