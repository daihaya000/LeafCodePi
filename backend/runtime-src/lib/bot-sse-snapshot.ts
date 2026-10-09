const REUSABLE_BOT_SNAPSHOT_FIELDS = [
  "task",
  "messages",
  "messageHistory",
  "permissionRequest",
  "questionRequest",
  "contextUsage",
  "isStreaming",
  "isCompacting",
  "manualAbortedAssistantId",
  "hangRetryCount",
  "revertLeafId",
  "intercomInbox",
] as const;

const MESSAGE_RESET_EVENTS = new Set(["revert", "unrevert", "conversation_reset"]);
const MAX_CACHED_FIELD_JSON_CHARS = 16_384;

export function createBotSseSnapshotDeduper() {
  const lastSentJson = new Map<string, string>();

  return (payload: Record<string, unknown>) => {
    if (payload.type !== "snapshot") return { payload, commit: () => {} };

    const forceMessages = payload.historyReset === true || MESSAGE_RESET_EVENTS.has(String(payload.eventType ?? ""));
    const wirePayload = { ...payload };
    const changedFields: [string, string][] = [];
    for (const field of REUSABLE_BOT_SNAPSHOT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const json = JSON.stringify(payload[field]);
      if (json === undefined) continue;
      if (json.length > MAX_CACHED_FIELD_JSON_CHARS) {
        // A long-lived EventSource must not retain a large transcript/inbox copy.
        lastSentJson.delete(field);
        continue;
      }
      if (field === "messages" && forceMessages) {
        changedFields.push([field, json]);
        continue;
      }
      if (lastSentJson.get(field) === json) delete wirePayload[field];
      else changedFields.push([field, json]);
    }

    return {
      payload: wirePayload,
      commit: () => {
        for (const [field, json] of changedFields) lastSentJson.set(field, json);
      },
    };
  };
}
