import { describe, expect, it } from "vitest";
import { lastAssistantWebSocketError } from "./harness";

const diagnostics = [{ type: "provider_transport_failure", error: { name: "WebSocketError", message: "WebSocket closed 1000" },
  details: { fallbackTransport: "sse", eventsEmitted: false } }];
const end = (stopReason: string, errorMessage?: string) => ({ type: "agent_end", messages: [
  { role: "assistant", stopReason, errorMessage, diagnostics },
] });

describe("transport recovery uses the final outcome, not stale diagnostics", () => {
  it.each(["stop", "toolUse", "length", "aborted"])("does not restart %s responses with fallback diagnostics", (reason) => {
    expect(lastAssistantWebSocketError(end(reason))).toBeNull();
  });
  it.each(["Request was aborted", "This operation was aborted", "401 unauthorized", "403 forbidden", "usage limit reached", "context length exceeded", "provider failed"])("does not retry a later terminal error: %s", (error) => {
    expect(lastAssistantWebSocketError(end("error", error))).toBeNull();
  });
  it.each(["WebSocket closed 1000", "WebSocketError", "terminated", "fetch failed"])("recovers a real WebSocket transport failure: %s", (error) => {
    expect(lastAssistantWebSocketError(end("error", error))).toContain(error);
  });
  it("does not read an older failure when the latest assistant succeeded", () => {
    const event = end("error", "WebSocket error");
    event.messages.push({ role: "assistant", stopReason: "stop", errorMessage: undefined, diagnostics: [] });
    expect(lastAssistantWebSocketError(event)).toBeNull();
  });
  it("does not misclassify a plain SSE error as a WebSocket failure", () => {
    expect(lastAssistantWebSocketError({ type: "agent_end", messages: [
      { role: "assistant", stopReason: "error", errorMessage: "terminated" },
    ] })).toBeNull();
  });
});
