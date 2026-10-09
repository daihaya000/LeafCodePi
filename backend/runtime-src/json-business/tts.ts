import { join } from "node:path";
import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { createTaskConversationCommands } from "@backend-core/task-conversation-command.mjs";
import { TTS_BUSINESS_BODY_LIMIT, publicTtsBusinessBody } from "@shared/tts-business-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import type { JsonBusinessInput } from "./index";
import { dataDir } from "../lib/paths";
import * as voices from "./handlers/settings/tts/voices/route";
import * as synthesis from "./handlers/tts/synthesize/route";
// Generation is concurrent; caller disconnect does not authorize a second provider attempt.
const commands = createTaskConversationCommands({ ledgerPath: () => join(dataDir(), "tts-synthesis-command.json") });
export async function dispatchTtsBusinessRequest(input: JsonBusinessInput, request: Request): Promise<JsonBusinessResult> {
  assertConfigurationOwner();
  if ((input.body?.byteLength ?? 0) > TTS_BUSINESS_BODY_LIMIT) return { status: 413, headers: {}, body: { error: "Request body is too large" } };
  const invoke = async () => {
    try {
      const response = input.route === "tts/synthesize"
        ? await synthesis.POST(request as Parameters<typeof synthesis.POST>[0]) : await voices.GET(request);
      const body = publicTtsBusinessBody(input.route, await response.json(), response.status);
      return body ? Response.json(body, { status: response.status })
        : Response.json({ error: "音声処理の結果を確認できません" }, { status: 503 });
    } catch { return Response.json({ error: "音声処理の結果を確認できません" }, { status: 503 }); }
  };
  const response = input.route === "tts/synthesize"
    ? await commands.run({ operationId: input.operationId, handler: invoke }) : await invoke();
  return { status: response.status, headers: { "cache-control": "no-store, private" }, body: await response.json() };
}
