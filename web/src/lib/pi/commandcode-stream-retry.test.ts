import assert from "node:assert/strict";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Api, AssistantMessage, AssistantMessageEvent,
  Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { describe, it } from "vitest";
import { withCommandCodeStreamRetry } from "./commandcode-stream-retry";

const errorText = "OpenAI Responses stream ended before a terminal response event";
const model: Model<Api> = { id: "test", name: "Test", api: "openai-responses", provider: "commandcode",
  baseUrl: "https://commandcode.test/provider/v1", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 64 };
const context = { messages: [] } as unknown as Context;
function message(content: AssistantMessage["content"] = []): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 };
}
function failure(content: AssistantMessage["content"] = [], text = errorText): AssistantMessageEvent {
  return { type: "error", reason: "error", error: { ...message(content), stopReason: "error", errorMessage: text } };
}
const done: AssistantMessageEvent = { type: "done", reason: "stop", message: message([{ type: "text", text: "OK" }]) };
function setup(attempts: AssistantMessageEvent[][]) {
  const calls: unknown[][] = [];
  const inner = (m: Model<Api>, c: Context, o?: SimpleStreamOptions) => {
    const stream = new AssistantMessageEventStream();
    calls.push([m, c, o]);
    queueMicrotask(() => { for (const event of attempts[calls.length - 1] ?? [done]) stream.push(event); stream.end(); });
    return stream;
  };
  const wrapped = withCommandCodeStreamRetry({ streamSimple: inner }).streamSimple as typeof inner;
  return { calls, wrapped };
}
async function collect(stream: AssistantMessageEventStream) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

describe("Command Code truncated Responses recovery", () => {
  it("leaves non-Responses reasoning streams unchanged", () => {
    const source = new AssistantMessageEventStream();
    const inner = () => source;
    const wrapped = withCommandCodeStreamRetry({ streamSimple: inner }).streamSimple as
      (m: Model<Api>, c: Context) => AssistantMessageEventStream;
    assert.equal(wrapped({ ...model, api: "openai-completions" }, context), source);
    source.end();
  });

  it("retries an empty failure once with identical model, context and account options", async () => {
    const { calls, wrapped } = setup([[failure()], [done]]);
    const options = { apiKey: "account-key", signal: new AbortController().signal };
    const { result, events } = await collect(wrapped(model, context, options));
    assert.equal(result.stopReason, "stop");
    assert.equal(calls.length, 2);
    for (const call of calls) assert.deepEqual(call, [model, context, options]);
    assert.deepEqual(events.map((event) => event.type), ["done"]);
  });

  it("discards failed reasoning instead of duplicating it on retry", async () => {
    const partial = message([{ type: "thinking", thinking: "discard me" }]);
    const { calls, wrapped } = setup([[
      { type: "start", partial }, { type: "thinking_start", contentIndex: 0, partial },
      { type: "thinking_delta", contentIndex: 0, delta: "discard me", partial }, failure(partial.content),
    ], [done]]);
    const { events } = await collect(wrapped(model, context));
    assert.equal(calls.length, 2);
    assert.deepEqual(events.map((event) => event.type), ["done"]);
  });

  it.each(["text_start", "toolcall_start"] as const)("never retries after %s", async (type) => {
    const partial = message();
    const { calls, wrapped } = setup([[{ type, contentIndex: 0, partial }, failure()]]);
    const { result, events } = await collect(wrapped(model, context));
    assert.equal(calls.length, 1);
    assert.equal(result.stopReason, "error");
    assert.deepEqual(events.map((event) => event.type), [type, "error"]);
  });

  it("preserves a second premature EOF as an error, never as success", async () => {
    const { calls, wrapped } = setup([[failure()], [failure()]]);
    const { result } = await collect(wrapped(model, context));
    assert.equal(calls.length, 2);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, errorText);
  });

  it("does not retry authentication errors or an aborted request", async () => {
    const ordinary = setup([[failure([], "403 upgrade_required")]]);
    await collect(ordinary.wrapped(model, context));
    assert.equal(ordinary.calls.length, 1);
    const aborted = setup([[failure()]]);
    const controller = new AbortController();
    controller.abort();
    await collect(aborted.wrapped(model, context, { signal: controller.signal }));
    assert.equal(aborted.calls.length, 1);
  });

  it("flushes the bounded reasoning buffer and disables retries", async () => {
    const partial = message();
    const { calls, wrapped } = setup([[
      { type: "thinking_delta", contentIndex: 0, delta: "x".repeat(65_536), partial }, failure(),
    ]]);
    const { result, events } = await collect(wrapped(model, context));
    assert.equal(calls.length, 1);
    assert.equal(result.stopReason, "error");
    assert.deepEqual(events.map((event) => event.type), ["thinking_delta", "error"]);
  });

  it("terminates an unexpected thrown failure instead of leaving result() pending", async () => {
    const wrapped = withCommandCodeStreamRetry({ streamSimple: () => { throw new Error("unexpected"); } });
    const stream = (wrapped.streamSimple as (m: Model<Api>, c: Context) => AssistantMessageEventStream)(model, context);
    assert.equal((await stream.result()).errorMessage, "unexpected");
  });
});
