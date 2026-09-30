import { randomUUID } from "node:crypto";

/**
 * Global keys are the wire contract with the extension-side copies in
 * extensions/leafcode-permission-gate/webui-bridge.ts and
 * extensions/leafcode-question/webui-question-bridge.ts.
 */
export const WEBUI_PERMISSION_HANDLER_KEY = "__leafcodeWebUiPermissionHandler";
export const WEBUI_QUESTION_HANDLER_KEY = "__leafcodeWebUiQuestionHandler";

function createSlot(key, host) {
  return {
    read: () => host[key] ?? null,
    write: (next) => { host[key] = next; },
  };
}

/** The host object is injectable; importing this module touches no global state. */
export function createPermissionBridge({ host = globalThis, uuid = () => randomUUID() } = {}) {
  const slot = createSlot(WEBUI_PERMISSION_HANDLER_KEY, host);
  return {
    registerWebUiPermissionHandler: (next) => slot.write(next),
    /** Returns null when no WebUI handler is registered or there is no session id. */
    async requestWebUiPermission(input) {
      if (!input.sessionId) return null;
      const handler = slot.read();
      if (!handler) return null;
      return handler({
        id: uuid(), sessionId: input.sessionId, command: input.command,
        labels: input.labels, message: input.message,
      });
    },
  };
}

export function createQuestionBridge({ host = globalThis, uuid = () => randomUUID() } = {}) {
  const slot = createSlot(WEBUI_QUESTION_HANDLER_KEY, host);
  return {
    registerWebUiQuestionHandler: (next) => slot.write(next),
    /** Returns null when no WebUI handler is registered. */
    async requestWebUiQuestion(input) {
      const handler = slot.read();
      if (!handler) return null;
      return handler({ id: uuid(), sessionId: input.sessionId, questions: input.questions });
    },
  };
}
