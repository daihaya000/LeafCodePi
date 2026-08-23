import { describe, expect, it } from "vitest";
import { sessionIdentityPatch } from "./session-identity";

const task = {
  sessionId: "session-1",
  sessionFile: "C:/sessions/session-1.jsonl",
  providerID: "openai",
  modelID: "gpt-5",
} as const;

describe("sessionIdentityPatch", () => {
  it("returns no patch when streaming events repeat the same identity", () => {
    expect(sessionIdentityPatch(task, task)).toEqual({});
  });

  it("returns only changed metadata", () => {
    expect(
      sessionIdentityPatch(task, {
        ...task,
        modelID: "gpt-5-mini",
      }),
    ).toEqual({ modelID: "gpt-5-mini" });
  });

  it("does not erase persisted IDs when the runtime has no model identity", () => {
    expect(sessionIdentityPatch(task, { sessionId: task.sessionId })).toEqual({});
  });
});
