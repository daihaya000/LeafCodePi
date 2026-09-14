import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTask } from "@/lib/store";
import { roomForCodeOrigin } from "@/lib/pi/bot-code-relay";
import {
  BOT_INTERCOM_MESSAGE_MAX,
  askBotIntercom,
  listBotIntercomPeers,
  listPendingBotIntercomAsks,
  replyBotIntercom,
  sendBotIntercom,
} from "@/lib/bot-intercom";

export const BOT_INTERCOM_TOOL = "intercom";

const BOT_INTERCOM_TOOL_DESCRIPTION =
  "Send a 1:1 Bot intercom message by Bot id only. Phase B supports list, send, ask, reply, and pending. Do not pass a session id, display name, or fromBot — the server derives the sender from this Bot. Room turns must not use this tool; a formal @Name of a room member is an implicit room_handoff only. ask waits for reply as the tool result. Use send to queue a mailbox delivery when the named Bot is offline.";

type IntercomAction = "list" | "send" | "ask" | "reply" | "pending";

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
  input: {
    action?: string;
    to?: string;
    message?: string;
    replyTo?: string;
    fromBot?: string;
    fromBotId?: string;
  },
  signal?: AbortSignal,
) {
  const action = (input.action ?? "").trim() as IntercomAction | "";
  if (action !== "list" && action !== "send" && action !== "ask" && action !== "reply" && action !== "pending") {
    return toolResult("Phase B supports action=list, send, ask, reply, or pending", { action: input.action ?? null }, true);
  }

  const fromBotId = senderBotId(originTaskId);
  const roomTurn = isRoomTurn(originTaskId);
  if (roomTurn) {
    return toolResult(
      "Intercom DM is not available during a Room turn; formal @ stays on room_handoff",
      { roomTurn: true },
      true,
    );
  }

  if (action === "list") {
    const peers = listBotIntercomPeers(fromBotId);
    if (peers.length === 0) {
      return toolResult("No other Bots are available.", { bots: [] });
    }
    const lines = peers.map((peer) => {
      const flags = [
        peer.resident ? "resident" : "not-resident (mailbox)",
        peer.intercomEnabled ? "opted-in" : "opted-out",
      ].join(", ");
      return `- ${peer.name} · ${peer.id} · ${flags}`;
    });
    return toolResult(`**Bots (id only):**\n${lines.join("\n")}`, { bots: peers });
  }

  if (action === "pending") {
    const pending = listPendingBotIntercomAsks(fromBotId);
    if (pending.length === 0) {
      return toolResult("No unresolved inbound asks.", { pendingAsks: [] });
    }
    const now = Date.now();
    const lines = pending.map((ask) => {
      const elapsedSeconds = Math.max(0, Math.floor((now - ask.createdAt) / 1000));
      return `- ${ask.fromName} · ${ask.fromBotId} · ${ask.id} · ${elapsedSeconds}s ago · ${ask.text.replace(/\s+/g, " ").slice(0, 80)}`;
    });
    return toolResult(`**Pending asks:**\n${lines.join("\n")}`, { pendingAsks: pending });
  }

  try {
    if (action === "send") {
      const message = sendBotIntercom({
        fromBotId,
        to: input.to ?? "",
        text: input.message ?? "",
      });
      return toolResult(`${message.queued ? "Queued for" : "Sent to"} Bot ${message.toBotId}`, {
        v: message.v,
        messageId: message.id,
        fromBotId: message.fromBotId,
        toBotId: message.toBotId,
        depth: message.depth,
        conversationId: message.conversationId,
        queued: message.queued === true,
      });
    }

    if (action === "ask") {
      const reply = await askBotIntercom({
        fromBotId,
        to: input.to ?? "",
        text: input.message ?? "",
        signal,
      });
      const name = reply.fromBotId;
      return toolResult(`**Reply from Bot ${name}:**\n${reply.text}`, {
        v: reply.v,
        messageId: reply.id,
        fromBotId: reply.fromBotId,
        toBotId: reply.toBotId,
        replyTo: reply.replyTo,
        conversationId: reply.conversationId,
        depth: reply.depth,
      });
    }

    const message = replyBotIntercom({
      fromBotId,
      to: input.to,
      replyTo: input.replyTo,
      text: input.message ?? "",
    });
    return toolResult(`Reply sent to Bot ${message.toBotId}`, {
      v: message.v,
      messageId: message.id,
      fromBotId: message.fromBotId,
      toBotId: message.toBotId,
      replyTo: message.replyTo,
      conversationId: message.conversationId,
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
      action: Type.String({ description: "list, send, ask, reply, or pending (Phase B)" }),
      to: Type.Optional(Type.String({ description: "Destination Bot id only (required for send/ask; disambiguates reply)" })),
      message: Type.Optional(Type.String({
        minLength: 1,
        maxLength: BOT_INTERCOM_MESSAGE_MAX,
        description: "Message text for send, ask, or reply",
      })),
      replyTo: Type.Optional(Type.String({ description: "Ask message id when more than one inbound ask is pending" })),
    }),
    async execute(_toolCallId, input, signal) {
      return executeBotIntercom(originTaskId, input as {
        action?: string;
        to?: string;
        message?: string;
        replyTo?: string;
        fromBot?: string;
        fromBotId?: string;
      }, signal);
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
