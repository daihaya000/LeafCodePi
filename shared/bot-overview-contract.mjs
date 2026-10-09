import { publicBot } from "./bot-lifecycle-contract.mjs";
import { publicTaskOperation } from "./task-collection-contract.mjs";

export const BOT_OVERVIEW_ROUTES = Object.freeze({ "bots/sidebar": ["GET"], "bots/[id]/intercom": ["GET", "PATCH"] });
export const BOT_OVERVIEW_BODY_LIMIT = 4096;
export function botOverviewTarget(path) {
  if (Object.hasOwn(BOT_OVERVIEW_ROUTES, path)) return { route: path, params: {} };
  const match = /^bots\/([^/]+)\/intercom$/.exec(path);
  if (!match) return null;
  try { return { route: "bots/[id]/intercom", params: { id: decodeURIComponent(match[1]) } }; } catch { return null; }
}
const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const string = v => typeof v === "string";
const boolean = v => typeof v === "boolean";
const number = v => typeof v === "number" && Number.isFinite(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const strings = v => Array.isArray(v) && v.every(string);
const nullableString = v => v === null || string(v);
const oneOf = values => v => values.includes(v);
const delivery = oneOf(["delivered", "queued", "steered", "cancelled", "superseded"]);
const kind = oneOf(["send", "ask", "reply"]);
const presence = oneOf(["online", "busy", "offline"]);
const codeState = oneOf(["queued", "starting", "running", "ready", "delivered", "cancelled"]);
function fields(value, schema, required = []) {
  if (!record(value)) throw new Error("Invalid DTO");
  const out = {};
  for (const key of required) if (value[key] === undefined) throw new Error("Missing DTO field");
  for (const [key, accept] of Object.entries(schema)) if (value[key] !== undefined) {
    if (!accept(value[key])) throw new Error("Invalid DTO field");
    out[key] = Array.isArray(value[key]) ? [...value[key]] : value[key];
  }
  return out;
}
function array(value, project) {
  if (!Array.isArray(value)) throw new Error("Invalid DTO array");
  return value.map(project);
}
function projectInbox(value) {
  const out = fields(value, { unreadCount: count }, ["unreadCount"]);
  out.messages = array(value.messages, message => {
    const row = fields(message, { v: v => v === 1, id: string, fromBotId: string, toBotId: string, fromName: string, text: string,
      createdAt: number, depth: count, kind, conversationId: string, replyTo: string, queued: boolean, delivery,
      supersedes: string, supersededBy: string, retryOf: string, cancelled: boolean, scopeId: string, fanout: boolean, fanoutDepth: count },
      ["v", "id", "fromBotId", "toBotId", "fromName", "text", "createdAt", "depth"]);
    if (message.attachments !== undefined) row.attachments = array(message.attachments, attachment => fields(attachment,
      { kind: oneOf(["image", "file"]), name: string, mimeType: string, file: string, bytes: count }, ["kind", "name", "mimeType", "file", "bytes"]));
    return row;
  });
  out.preview = value.preview === null ? null : fields(value.preview, { fromBotId: string, fromName: string, text: string, createdAt: number, kind }, ["fromBotId", "fromName", "text", "createdAt"]);
  out.pendingAsks = array(value.pendingAsks, ask => fields(ask, { id: string, conversationId: string, fromBotId: string, fromName: string, text: string, createdAt: number, expiresAt: number }, ["id", "conversationId", "fromBotId", "fromName", "text", "createdAt", "expiresAt"]));
  if (value.peerPresence !== undefined) out.peerPresence = value.peerPresence === null ? null : fields(value.peerPresence, { botId: string, name: string, status: presence }, ["botId", "name", "status"]);
  return out;
}
export function publicBotInbox(value) { try { return projectInbox(value); } catch { return null; } }
function goalReport(value) {
  return fields(value, { status: string, maxTurns: number, turnCount: number, acceptance: strings, pauseReason: string, blockedReason: string, summary: string, evidence: string, rejectedClaims: number }, ["status"]);
}
function roomMessage(value) {
  const out = fields(value, { id: string, role: oneOf(["user", "assistant"]), text: string, createdAt: v => v === null || typeof v === "number",
    botId: string, botName: string, status: oneOf(["working", "done", "error"]), codeRequestId: string, codeTaskId: nullableString, codeState,
    codeActivity: string, openerReason: oneOf(["keyword", "llm"]), sourceBotId: string, relayTurnId: string, relayDepth: count, relayParentMessageId: string }, ["id", "role", "text", "createdAt"]);
  // Existing previews tolerate invalid timestamps; JSON historically represented them as null.
  if (!number(out.createdAt)) out.createdAt = null;
  if (value.conversation !== undefined) out.conversation = fields(value.conversation, { requestId: string, participantIds: strings, turn: count, maxTurns: count }, ["requestId", "participantIds", "turn", "maxTurns"]);
  if (value.images !== undefined) out.images = array(value.images, image => fields(image, { file: string, mimeType: string }, ["file", "mimeType"]));
  if (value.files !== undefined) out.files = array(value.files, file => fields(file, { file: string, mimeType: string, name: string, size: count }, ["file", "mimeType", "name", "size"]));
  if (value.handoffs !== undefined) out.handoffs = array(value.handoffs, handoff => fields(handoff, { id: string, toBotId: string, toBotName: string, state: oneOf(["waiting", "ready", "running", "done", "failed", "cancelled"]) }, ["id", "toBotId", "toBotName", "state"]));
  if (value.codeRequests !== undefined) out.codeRequests = array(value.codeRequests, request => {
    const row = fields(request, { id: string, taskId: nullableString, state: codeState, prompt: string, outcome: string, activity: string }, ["id", "taskId", "state"]);
    if (request.goalLoop !== undefined) row.goalLoop = goalReport(request.goalLoop);
    if (request.goalLoopSummary !== undefined) row.goalLoopSummary = fields(request.goalLoopSummary, { status: string, maxTurns: number, turnCount: number }, ["status", "maxTurns", "turnCount"]);
    if (request.todoProgress !== undefined) row.todoProgress = fields(request.todoProgress, { completed: count, total: count }, ["completed", "total"]);
    return row;
  });
  return out;
}
/** Full existing Room/sidebar DTO, with authored content retained and server capability tokens omitted. */
export function publicSidebarRoom(value) {
  try {
    const out = fields(value, { id: string, name: string, members: strings, botRelayEnabled: boolean, codeAutoApprove: boolean, createdAt: string, updatedAt: string, lastMessageSummary: nullableString, lastMessageAt: nullableString }, ["id", "name", "members", "botRelayEnabled", "createdAt", "updatedAt", "lastMessageSummary", "lastMessageAt"]);
    out.messages = array(value.messages, roomMessage);
    if (value.lastOutcome !== undefined) out.lastOutcome = fields(value.lastOutcome, { kind: oneOf(["code-wait", "members", "turns", "repeat", "done", "mention"]), requestId: string }, ["kind", "requestId"]);
    if (value.handoffs !== undefined) out.handoffs = array(value.handoffs, handoff => fields(handoff, { id: string, requestId: string, fromMessageId: string, fromBotId: string, toBotId: string, task: string,
      waitForCodeRequestId: string, state: oneOf(["waiting", "ready", "running", "done", "failed", "cancelled"]), reason: string, responseMessageId: string, toolCallId: string, relayDepth: count, implicit: boolean, createdAt: number, updatedAt: number }, ["id", "requestId", "fromMessageId", "fromBotId", "toBotId", "task", "state", "createdAt"]));
    return out;
  } catch { return null; }
}
export function publicBotOverviewBody(route, value, status, method) {
  try {
    if (!Object.hasOwn(BOT_OVERVIEW_ROUTES, route)) return null;
    const out = fields(value, { error: string });
    if (status < 400) {
      if (out.error !== undefined) return null;
      if (route === "bots/sidebar") {
        out.bots = array(value.bots, bot => {
          const dto = publicBot(bot);
          if (!dto) throw new Error("Invalid Bot DTO");
          return { ...dto, ...fields(bot, { lastMessageSummary: nullableString, lastMessageAt: nullableString, codeInProgress: boolean, codeSessionCount: count }, ["lastMessageSummary", "lastMessageAt", "codeInProgress", "codeSessionCount"]) };
        });
        out.rooms = array(value.rooms, room => { const dto = publicSidebarRoom(room); if (!dto) throw new Error("Invalid Room DTO"); return dto; });
      } else { out.inbox = projectInbox(value.inbox); }
    }
    if (value.operation !== undefined && method !== "GET") { out.operation = publicTaskOperation(value.operation); if (!out.operation) return null; }
    return out;
  } catch { return null; }
}
