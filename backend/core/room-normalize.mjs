/**
 * Validation of persisted Room JSON. Room files are read back from disk written
 * by older builds or other workers, so anything that does not match the contract
 * is dropped rather than trusted. Pure: the handoff state vocabulary (a shared
 * constant owned by the DTO module) is injected.
 */

export const ROOM_OUTCOME_KINDS = ["code-wait", "members", "turns", "repeat", "done", "mention"];

export function normalizeOutcome(value) {
  const outcome = value;
  return outcome && typeof outcome.requestId === "string" && typeof outcome.kind === "string" && ROOM_OUTCOME_KINDS.includes(outcome.kind)
    ? { kind: outcome.kind, requestId: outcome.requestId }
    : undefined;
}

function isValidMessage(item) {
  return Boolean(
    item && typeof item === "object" && typeof item.id === "string"
    && (item.role === "user" || item.role === "assistant")
    && typeof item.text === "string" && typeof item.createdAt === "number"
    && (!("files" in item) || (Array.isArray(item.files) && item.files.every((file) => Boolean(
      file && typeof file === "object" && typeof file.file === "string" && typeof file.name === "string"
      && typeof file.mimeType === "string" && typeof file.size === "number",
    )))),
  );
}

/** Returns the normalized room, or null when the record is not a room with this id. */
export function normalizeRoom(value, id, handoffStates) {
  if (value.id !== id || typeof value.name !== "string" || !Array.isArray(value.members)) return null;
  const messages = Array.isArray(value.messages) ? value.messages.filter(isValidMessage) : [];
  const lastOutcome = normalizeOutcome(value.lastOutcome);
  const isHandoff = (item) => {
    const handoff = item;
    return Boolean(handoff && typeof handoff === "object" && typeof handoff.id === "string" && typeof handoff.requestId === "string"
      && typeof handoff.fromMessageId === "string" && typeof handoff.fromBotId === "string" && typeof handoff.toBotId === "string"
      && typeof handoff.task === "string" && handoffStates.includes(handoff.state) && typeof handoff.createdAt === "number");
  };
  const handoffs = Array.isArray(value.handoffs) ? value.handoffs.filter(isHandoff) : [];
  return {
    id,
    name: value.name,
    members: [...new Set(value.members.filter((item) => typeof item === "string"))],
    botRelayEnabled: value.botRelayEnabled === true,
    ...(value.codeAutoApprove === true ? { codeAutoApprove: true } : {}),
    ...(lastOutcome ? { lastOutcome } : {}),
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    messages,
    ...(handoffs.length > 0 ? { handoffs } : {}),
  };
}
