/**
 * Room-to-Room Bot relay envelopes. An envelope is a single-use, deeply bounded
 * capability: it is issued for a room and fan-out, then claimed under the room
 * lock so two workers cannot both act on it.
 *
 * Storage, room lookup, bot enablement, the room lock, the clock and UUIDs are
 * injected, so this module holds no process-local state.
 */
export const MAX_ROOM_RELAY_DEPTH = 3;
export const RELAY_ENVELOPE_TTL_MS = 10 * 60 * 1000;

/** A relay participant must be a member of the room and currently enabled. */
export function relayBotIsActive(room, botId, isBotEnabled) {
  return Boolean(room?.members?.includes(botId)) && isBotEnabled(botId) === true;
}

/**
 * Bots already involved in this turn: claimed in relay state plus any message
 * stamped with the turn. Called twice on purpose in the original flow (once per
 * check) so both callers see the current file.
 */
export function collectRelayParticipants(room, state, turnId) {
  const ids = new Set(state.claims[turnId] ?? []);
  for (const message of room?.messages ?? []) {
    if (message.relayTurnId !== turnId) continue;
    if (message.sourceBotId) ids.add(message.sourceBotId);
    if (message.botId) ids.add(message.botId);
  }
  return ids;
}

/** A parent envelope must be consumed, from this room, unexpired and have called on the source bot. */
export function parentRelayEnvelopeRejection(parentId, parent, roomId, sourceBotId, nowMs) {
  if (!parentId) return false;
  return Boolean(
    !parent || !parent.consumed || parent.roomId !== roomId
    || parent.expiresAt <= nowMs || !parent.targetBotIds.includes(sourceBotId),
  );
}

/** A claimed envelope must be live, unexpired and still fan out to active, uninvolved bots. */
export function relayEnvelopeRejection(envelope, { room, roomId, nowMs, isBotEnabled, isTargetInvolved }) {
  if (!room?.botRelayEnabled || !envelope || envelope.roomId !== roomId) return true;
  if (envelope.consumed || envelope.expiresAt <= nowMs) return true;
  if (!relayBotIsActive(room, envelope.sourceBotId, isBotEnabled)) return true;
  if (!Array.isArray(envelope.targetBotIds) || envelope.targetBotIds.length === 0) return true;
  if (envelope.targetBotIds.some((id) => id === envelope.sourceBotId || !relayBotIsActive(room, id, isBotEnabled))) return true;
  return envelope.targetBotIds.some((id) => isTargetInvolved(id));
}

/** Server-only capability. The route accepts only the returned opaque envelope, never its fields. */
export function issueRelayEnvelope({ roomId, sourceBotId, targetBotIds, parentId }, deps) {
  return deps.withRoomLock(roomId, () => {
    const room = deps.getRoom(roomId);
    if (!room?.botRelayEnabled || !relayBotIsActive(room, sourceBotId, deps.isBotEnabled)) return undefined;
    const targets = [...new Set(targetBotIds)];
    if (targets.length === 0 || targets.some((id) => id === sourceBotId || !relayBotIsActive(room, id, deps.isBotEnabled))) return undefined;
    const state = deps.readState(roomId);
    const parent = parentId ? state.envelopes[parentId] : undefined;
    if (parentRelayEnvelopeRejection(parentId, parent, roomId, sourceBotId, deps.now())) return undefined;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > MAX_ROOM_RELAY_DEPTH) return undefined;
    const turnId = parent?.turnId ?? deps.uuid();
    const participants = collectRelayParticipants(deps.getRoom(roomId), deps.readState(roomId), turnId);
    if (targets.some((id) => participants.has(id))) return undefined;
    const token = deps.uuid();
    state.envelopes[token] = {
      roomId, sourceBotId, targetBotIds: targets, turnId, depth, parentId,
      consumed: false, expiresAt: deps.now() + RELAY_ENVELOPE_TTL_MS,
    };
    deps.writeState(roomId, state);
    return token;
  });
}

/** Validate then claim: single-use, durable across workers/restarts. */
export function consumeRelayEnvelope({ roomId, token }, deps) {
  return deps.withRoomLock(roomId, () => {
    const state = deps.readState(roomId);
    const envelope = state.envelopes[token];
    const room = deps.getRoom(roomId);
    const nowMs = deps.now();
    const participants = envelope
      ? collectRelayParticipants(room, state, envelope.turnId)
      : new Set();
    if (relayEnvelopeRejection(envelope, {
      room, roomId, nowMs, isBotEnabled: deps.isBotEnabled, isTargetInvolved: (id) => participants.has(id),
    })) return undefined;
    envelope.consumed = true;
    const claims = new Set(state.claims[envelope.turnId] ?? []);
    claims.add(envelope.sourceBotId);
    for (const id of envelope.targetBotIds) claims.add(id);
    state.claims[envelope.turnId] = [...claims];
    deps.writeState(roomId, state);
    return {
      roomId: envelope.roomId, sourceBotId: envelope.sourceBotId,
      targetBotIds: envelope.targetBotIds, turnId: envelope.turnId, depth: envelope.depth,
    };
  });
}
