import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTask } from "@/lib/store";
import { roomForCodeOrigin } from "@/lib/pi/bot-code-relay";
import {
  BOT_INTERCOM_MESSAGE_MAX,
  MAX_BOT_INTERCOM_FANOUT,
  askBotIntercom,
  cancelBotIntercom,
  fanoutBotIntercom,
  listBotIntercomCwdPeers,
  listBotIntercomPeers,
  listPendingBotIntercomAsks,
  replyBotIntercom,
  sendBotIntercom,
  type BotIntercomAttachmentInput,
} from "@/lib/bot-intercom";

export const BOT_INTERCOM_TOOL = "intercom";

const BOT_INTERCOM_TOOL_DESCRIPTION =
  "Send a 1:1 Bot intercom message by Bot id only. Phase D supports list, list-cwd, send, ask, reply, pending, cancel, and fanout. Do not pass a session id, display name, or fromBot — the server derives the sender from this Bot. list and list-cwd return the same-scope Bot roster (list-cwd may also filter by a shared extraRoot/workspace path). Out-of-scope Bots are never listed and cannot be sent to. fanout is a guarded same-scope broadcast: default OFF, requires the sender's fanout opt-in, max 8 recipients, and cannot amplify a received fanout. Room turns must not use this tool; a formal @Name of a room member is an implicit room_handoff only. ask waits for reply as the tool result. Use send to queue or steer a mailbox delivery (offline = queued, busy = steered). cancel and supersedes are the same sender-recipient pair only. Attachments follow Room limits (images png/jpeg/webp/gif, UTF-8 files, 8 each, 8MB).";

type IntercomAction = "list" | "list-cwd" | "send" | "ask" | "reply" | "pending" | "cancel" | "fanout";

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

function asFanoutTargets(to: string | undefined, toIds: unknown): string[] {
  const fromArray = Array.isArray(toIds)
    ? toIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)
    : [];
  const fromString = typeof to === "string"
    ? to.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean)
    : [];
  return [...new Set([...fromArray, ...fromString])];
}

function asAttachmentInputs(value: unknown): BotIntercomAttachmentInput[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`attachments[${index}] is invalid`);
    const row = item as { name?: unknown; mimeType?: unknown; data?: unknown };
    if (typeof row.mimeType !== "string" || typeof row.data !== "string") {
      throw new Error(`attachments[${index}] needs mimeType and data`);
    }
    return {
      mimeType: row.mimeType,
      data: row.data,
      ...(typeof row.name === "string" ? { name: row.name } : {}),
    };
  });
}

async function executeBotIntercom(
  originTaskId: string,
  input: {
    action?: string;
    to?: string;
    message?: string;
    replyTo?: string;
    messageId?: string;
    supersedes?: string;
    retryOf?: string;
    attachments?: unknown;
    cwd?: string;
    toIds?: unknown;
    fromBot?: string;
    fromBotId?: string;
  },
  signal?: AbortSignal,
) {
  const action = (input.action ?? "").trim() as IntercomAction | "";
  if (action !== "list" && action !== "list-cwd" && action !== "send" && action !== "ask" && action !== "reply" && action !== "pending" && action !== "cancel" && action !== "fanout") {
    return toolResult("Phase D supports action=list, list-cwd, send, ask, reply, pending, cancel, or fanout", { action: input.action ?? null }, true);
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

  if (action === "list" || action === "list-cwd") {
    const peers = action === "list-cwd"
      ? listBotIntercomCwdPeers(fromBotId, input.cwd)
      : listBotIntercomPeers(fromBotId);
    if (peers.length === 0) {
      return toolResult(
        action === "list-cwd" ? "No same-scope Bots match this directory." : "No other same-scope Bots are available.",
        { bots: [], scope: true },
      );
    }
    const lines = peers.map((peer) => {
      const flags = [
        peer.presence,
        `scope ${peer.scopeId}`,
        peer.resident ? "resident" : "not-resident (mailbox)",
        peer.intercomEnabled ? "opted-in" : "opted-out",
        peer.fanoutEnabled ? "fanout-on" : "fanout-off",
      ].join(", ");
      return `- ${peer.name} · ${peer.id} · ${flags}`;
    });
    const heading = action === "list-cwd" ? "**Same-scope Bots (cwd filter, id only):**" : "**Same-scope Bots (id only):**";
    return toolResult(`${heading}\n${lines.join("\n")}`, { bots: peers });
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
    if (action === "cancel") {
      const message = cancelBotIntercom({
        fromBotId,
        messageId: input.messageId ?? "",
      });
      return toolResult(`Cancelled ${message.id}`, {
        v: message.v,
        messageId: message.id,
        fromBotId: message.fromBotId,
        toBotId: message.toBotId,
        delivery: message.delivery,
        cancelled: true,
      });
    }

    const attachments = asAttachmentInputs(input.attachments);

    if (action === "fanout") {
      const messages = fanoutBotIntercom({
        fromBotId,
        to: asFanoutTargets(input.to, input.toIds),
        text: input.message ?? "",
        attachments,
      });
      const ids = messages.map((message) => message.toBotId);
      return toolResult(`Fanout delivered to ${messages.length} Bot${messages.length === 1 ? "" : "s"}`, {
        v: messages[0]?.v,
        fanout: true,
        count: messages.length,
        toBotIds: ids,
        messageIds: messages.map((message) => message.id),
        fromBotId: messages[0]?.fromBotId,
        scopeId: messages[0]?.scopeId,
        fanoutDepth: messages[0]?.fanoutDepth,
      });
    }

    if (action === "send") {
      const message = sendBotIntercom({
        fromBotId,
        to: input.to ?? "",
        text: input.message ?? "",
        attachments,
        supersedes: input.supersedes,
        retryOf: input.retryOf,
      });
      return toolResult(`${message.queued ? "Queued for" : message.delivery === "steered" ? "Steered to" : "Sent to"} Bot ${message.toBotId}`, {
        v: message.v,
        messageId: message.id,
        fromBotId: message.fromBotId,
        toBotId: message.toBotId,
        depth: message.depth,
        conversationId: message.conversationId,
        queued: message.queued === true,
        delivery: message.delivery,
        ...(message.supersedes ? { supersedes: message.supersedes } : {}),
        ...(message.attachments ? { attachments: message.attachments } : {}),
      });
    }

    if (action === "ask") {
      const reply = await askBotIntercom({
        fromBotId,
        to: input.to ?? "",
        text: input.message ?? "",
        attachments,
        supersedes: input.supersedes,
        retryOf: input.retryOf,
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
        delivery: reply.delivery,
      });
    }

    const message = replyBotIntercom({
      fromBotId,
      to: input.to,
      replyTo: input.replyTo,
      text: input.message ?? "",
      attachments,
    });
    return toolResult(`Reply sent to Bot ${message.toBotId}`, {
      v: message.v,
      messageId: message.id,
      fromBotId: message.fromBotId,
      toBotId: message.toBotId,
      replyTo: message.replyTo,
      conversationId: message.conversationId,
      depth: message.depth,
      delivery: message.delivery,
      ...(message.attachments ? { attachments: message.attachments } : {}),
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
      action: Type.String({ description: "list, list-cwd, send, ask, reply, pending, cancel, or fanout (Phase D)" }),
      to: Type.Optional(Type.String({ description: "Destination Bot id only (required for send/ask; disambiguates reply). For fanout, comma-separated Bot ids." })),
      toIds: Type.Optional(Type.Array(Type.String({ description: "Destination Bot ids for fanout (alternative to comma-separated to)" }), { maxItems: MAX_BOT_INTERCOM_FANOUT })),
      message: Type.Optional(Type.String({
        minLength: 1,
        maxLength: BOT_INTERCOM_MESSAGE_MAX,
        description: "Message text for send, ask, reply, or fanout",
      })),
      replyTo: Type.Optional(Type.String({ description: "Ask message id when more than one inbound ask is pending" })),
      messageId: Type.Optional(Type.String({ description: "Outbound message id to cancel" })),
      supersedes: Type.Optional(Type.String({ description: "Outbound message id this send/ask replaces (same sender and recipient)" })),
      retryOf: Type.Optional(Type.String({ description: "Optional metadata linking this message as a retry" })),
      cwd: Type.Optional(Type.String({ description: "Directory filter for list-cwd. Matches a Bot workspace or extraRoot. Omit to list the same-scope roster." })),
      attachments: Type.Optional(Type.Array(Type.Object({
        mimeType: Type.String({ description: "image/png, image/jpeg, image/webp, image/gif, or a UTF-8 text MIME type" }),
        data: Type.String({ description: "Base64 payload. Room limits: 8 images + 8 files, 8MB each" }),
        name: Type.Optional(Type.String({ description: "File name (required for non-image attachments)" })),
      }), { maxItems: 16, description: "Room-aligned attachments (8 images + 8 UTF-8 files, 8MB each)" })),
    }),
    async execute(_toolCallId, input, signal) {
      return executeBotIntercom(originTaskId, input as {
        action?: string;
        to?: string;
        message?: string;
        replyTo?: string;
        messageId?: string;
        supersedes?: string;
        retryOf?: string;
        attachments?: unknown;
        cwd?: string;
        toIds?: unknown;
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
