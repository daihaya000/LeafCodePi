import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTask } from "@/lib/store";
import { roomForCodeOrigin } from "@/lib/pi/bot-code-relay";
import {
  BOT_INTERCOM_MESSAGE_MAX,
  listBotIntercomPeers,
  sendBotIntercom,
} from "@/lib/bot-intercom";

export const BOT_INTERCOM_TOOL = "intercom";

const BOT_INTERCOM_TOOL_DESCRIPTION =
  "Send a 1:1 Bot intercom message by Bot id only. Phase A supports list and send. Do not pass a session id, display name, or fromBot — the server derives the sender from this Bot. Room turns must not use this tool; a formal @Name of a room member is an implicit room_handoff only.";

type IntercomAction = "list" | "send";

function toolResult(text: string, details: Record<string, unknown>, error = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: error ? { error: true, ...details } : details,
  };
}

function senderBotId(originTaskId: string): string {
  const task = getTask(originTaskId);
  if (task?.kind !== "bot" || !task.botId) {
    throw new Error("intercom is only available on a Bot task");
  }
  return task.botId;
}

function isRoomTurn(originTaskId: string): boolean {
  return Boolean(roomForCodeOrigin(getTask(originTaskId)));
}

async function executeBotIntercom(
  originTaskId: string,
  input: { action?: string; to?: string; message?: string; fromBot?: string; fromBotId?: string },
) {
  const action = (input.action ?? "").trim() as IntercomAction | "";
  if (action !== "list" && action !== "send") {
    return toolResult("Phase A supports action=list or action=send only", { action: input.action ?? null }, true);
  }

  const fromBotId = senderBotId(originTaskId);
  if (action === "list") {
    if (isRoomTurn(originTaskId)) {
      return toolResult(
        "Intercom DM is not available during a Room turn; formal @ stays on room_handoff",
        { roomTurn: true },
        true,
      );
    }
    const peers = listBotIntercomPeers(fromBotId);
    if (peers.length === 0) {
      return toolResult("No other Bots are available.", { bots: [] });
    }
    const lines = peers.map((peer) => {
      const flags = [
        peer.resident ? "resident" : "not-resident",
        peer.intercomEnabled ? "opted-in" : "opted-out",
      ].join(", ");
      return `- ${peer.name} · ${peer.id} · ${flags}`;
    });
    return toolResult(`**Bots (id only):**\n${lines.join("\n")}`, { bots: peers });
  }

  try {
    const message = sendBotIntercom({
      fromBotId,
      to: input.to ?? "",
      text: input.message ?? "",
      roomTurn: isRoomTurn(originTaskId),
    });
    return toolResult(`Sent to Bot ${message.toBotId}`, {
      v: message.v,
      messageId: message.id,
      fromBotId: message.fromBotId,
      toBotId: message.toBotId,
      depth: message.depth,
    });
  } catch (error) {
    return toolResult(error instanceof Error ? error.message : String(error), { error: true }, true);
  }
}

function registerBridgeTool(pi: ExtensionAPI, originTaskId: string): void {
  pi.registerTool({
    name: BOT_INTERCOM_TOOL,
    label: "内線",
    description: BOT_INTERCOM_TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: Type.String({ description: "list or send (Phase A)" }),
      to: Type.Optional(Type.String({ description: "Destination Bot id only" })),
      message: Type.Optional(Type.String({
        minLength: 1,
        maxLength: BOT_INTERCOM_MESSAGE_MAX,
        description: "Message text for send",
      })),
    }),
    async execute(_toolCallId, input) {
      return executeBotIntercom(originTaskId, input as {
        action?: string;
        to?: string;
        message?: string;
        fromBot?: string;
        fromBotId?: string;
      });
    },
  });
}

/**
 * Bridges the existing `intercom` tool name onto the Bot roster.
 * session_start re-registers so leafcode-intercom cannot keep a session-id send path on Bot tasks.
 */
export function botIntercomTool(originTaskId: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    registerBridgeTool(pi, originTaskId);
    pi.on("session_start", () => {
      registerBridgeTool(pi, originTaskId);
    });
  };
}
