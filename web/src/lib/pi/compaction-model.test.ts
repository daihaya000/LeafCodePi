import { describe, expect, it, vi } from "vitest";
import { compactWithConfiguredModel } from "./compaction-model";

function route() {
  return { model: { id: "m" }, streamFn: vi.fn(), release: vi.fn() };
}

describe("compactWithConfiguredModel", () => {
  it("keeps Pi's default summary when no model is configured", async () => {
    const resolve = vi.fn();
    const result = await compactWithConfiguredModel({
      value: "",
      effort: null,
      signal: new AbortController().signal,
      resolve,
      compact: vi.fn(),
    });
    expect(result).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("summarizes with the configured model and effort, then releases it", async () => {
    const resolved = route();
    const compact = vi.fn().mockResolvedValue({ summary: "s" });
    const result = await compactWithConfiguredModel({
      value: "acc::anthropic::claude",
      effort: "low",
      signal: new AbortController().signal,
      resolve: vi.fn().mockResolvedValue(resolved),
      compact,
    });
    expect(result).toEqual({ summary: "s" });
    expect(compact).toHaveBeenCalledWith(resolved.model, resolved.streamFn, "low");
    expect(resolved.release).toHaveBeenCalledOnce();
  });

  it("ignores an invalid effort", async () => {
    const compact = vi.fn().mockResolvedValue({ summary: "s" });
    await compactWithConfiguredModel({
      value: "anthropic::claude",
      effort: "bogus",
      signal: new AbortController().signal,
      resolve: vi.fn().mockResolvedValue(route()),
      compact,
    });
    expect(compact.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("falls back and reports when the model is missing or fails", async () => {
    const onError = vi.fn();
    expect(await compactWithConfiguredModel({
      value: "anthropic::gone",
      effort: null,
      signal: new AbortController().signal,
      resolve: vi.fn().mockResolvedValue(undefined),
      compact: vi.fn(),
      onError,
    })).toBeUndefined();
    const resolved = route();
    expect(await compactWithConfiguredModel({
      value: "anthropic::claude",
      effort: null,
      signal: new AbortController().signal,
      resolve: vi.fn().mockResolvedValue(resolved),
      compact: vi.fn().mockRejectedValue(new Error("boom")),
      onError,
    })).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(resolved.release).toHaveBeenCalledOnce();
  });

  it("does not report an error after the user aborts", async () => {
    const controller = new AbortController();
    const onError = vi.fn();
    const result = await compactWithConfiguredModel({
      value: "anthropic::claude",
      effort: null,
      signal: controller.signal,
      resolve: vi.fn().mockResolvedValue(route()),
      compact: vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
      onError,
    });
    expect(result).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});
