import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTask } from "@/lib/store";
import { roomForCodeOrigin } from "@/lib/pi/bot-code-relay";

export const ROOM_HANDOFF_TOOL = "room_handoff";
const ROOM_HANDOFF_TOOL_DESCRIPTION = "Register follow-up work for another participant of this Room so the server can wake them automatically. Use it whenever your message asks a teammate to do later work (for example, verify or review after a Code run finishes): pass their exact participant id, a concrete task, and optionally the code request id (from a code_session result) the task must wait for. A prose @mention alone registers nothing. Do not register work for yourself, and do not claim the teammate has started.";

/**
 * Registers follow-up work for another Room participant. The room, conversation, and speaker are
 * resolved from the calling task on the server; room-runtime does the validation and persistence.
 */
export function roomHandoffTool(originTaskId: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: ROOM_HANDOFF_TOOL, label: "Room Handoff",
      description: ROOM_HANDOFF_TOOL_DESCRIPTION,
      parameters: Type.Object({
        toBotId: Type.String({ description: "Exact participant id (or exact name) of the teammate receiving the work" }),
        task: Type.String({ minLength: 1, maxLength: 2_000, description: "Concrete task for the teammate" }),
        waitForCodeRequestId: Type.Optional(Type.String({ description: "code_session request id this task must wait for before starting" })),
      }),
      async execute(toolCallId, input) {
        // Lazy import: room-runtime pulls the whole harness, which registers this tool.
        const { registerRoomHandoff } = await import("@/lib/room-runtime");
        const sessionTask = getTask(originTaskId);
        const room = roomForCodeOrigin(sessionTask);
        if (!room || !sessionTask?.botId) throw new Error("room_handoff is only available inside a Room turn");
        const botId = sessionTask.botId;
        const response = room.messages.findLast((message) => message.botId === botId && message.status === "working");
        const requestId = response?.conversation?.requestId;
        const latestUser = room.messages.findLast((message) => message.role === "user");
        if (!response || !requestId || requestId !== latestUser?.id) throw new Error("Room request is no longer active");
        const { handoff, duplicate } = registerRoomHandoff({
          roomId: room.id, requestId, fromMessageId: response.id, fromBotId: botId,
          toBotId: input.toBotId, task: input.task,
          ...(input.waitForCodeRequestId ? { waitForCodeRequestId: input.waitForCodeRequestId } : {}),
          ...(toolCallId ? { toolCallId } : {}),
        });
        const result = {
          handoffId: handoff.id, toBotId: handoff.toBotId, state: handoff.state, duplicate,
          message: duplicate
            ? "Already registered; this call changed nothing."
            : handoff.state === "waiting"
              ? `Registered. It starts automatically after code request ${handoff.waitForCodeRequestId} reports, even if you end your reply with ROOM_ACTION: DONE. Do not claim the teammate has started.`
              : "Registered. The teammate is woken as soon as this turn ends. Do not claim they have started.",
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    });
  };
}
