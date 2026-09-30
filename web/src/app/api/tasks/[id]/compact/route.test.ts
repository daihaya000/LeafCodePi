import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compactTask: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
  forwardTaskCompact: vi.fn(),
  localRuntimeBlocked: vi.fn(() => false),
}));

vi.mock("@/lib/pi/harness", () => mocks);
vi.mock("@/lib/backend-forward", () => ({ forwardTaskCompact: mocks.forwardTaskCompact }));
vi.mock("@/lib/pi/runtime-ownership", () => ({
  localRuntimeBlocked: mocks.localRuntimeBlocked,
  assertLocalRuntimeAllowed: vi.fn(),
}));

import { MAX_PROMPT_TEXT_CHARS } from "@/lib/prompt-images";
import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tasks/task-1/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tasks/[id]/compact", () => {
  beforeEach(() => {
    mocks.compactTask.mockReset();
    mocks.compactTask.mockResolvedValue({ id: "task-1" });
    mocks.forwardTaskCompact.mockReset();
    mocks.forwardTaskCompact.mockResolvedValue({ ok: true, task: { id: "task-1" } });
    mocks.localRuntimeBlocked.mockReturnValue(false);
  });

  it("rejects a malformed request body before compacting", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/tasks/task-1/compact", {
        method: "POST",
        body: "[]",
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.compactTask).not.toHaveBeenCalled();
  });

  it("rejects non-string custom instructions before compacting", async () => {
    const response = await POST(
      request({ customInstructions: 123 }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.compactTask).not.toHaveBeenCalled();
  });

  it("rejects oversized custom instructions before compacting", async () => {
    const response = await POST(
      request({ customInstructions: "x".repeat(MAX_PROMPT_TEXT_CHARS + 1) }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(413);
    expect(mocks.compactTask).not.toHaveBeenCalled();
  });

  it("accepts custom instructions at the size limit", async () => {
    const response = await POST(
      request({ customInstructions: "x".repeat(MAX_PROMPT_TEXT_CHARS) }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.compactTask).toHaveBeenCalledWith("task-1", "x".repeat(MAX_PROMPT_TEXT_CHARS));
  });

  it("forwards the compaction after the cutover without starting it here", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);

    const response = await POST(request({ customInstructions: "要点だけ" }), { params: Promise.resolve({ id: "task-1" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task: { id: "task-1" } });
    expect(mocks.forwardTaskCompact).toHaveBeenCalledWith("task-1", "要点だけ");
    expect(mocks.compactTask).not.toHaveBeenCalled();
  });

  it("keeps its own validation before forwarding", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);

    expect((await POST(request({ customInstructions: 123 }), { params: Promise.resolve({ id: "task-1" }) })).status).toBe(400);
    expect((await POST(request({ customInstructions: "x".repeat(MAX_PROMPT_TEXT_CHARS + 1) }), { params: Promise.resolve({ id: "task-1" }) })).status).toBe(413);
    expect(mocks.forwardTaskCompact).not.toHaveBeenCalled();
  });

  it("reports a forwarded failure with its status", async () => {
    mocks.localRuntimeBlocked.mockReturnValue(true);
    mocks.forwardTaskCompact.mockResolvedValue({ ok: false, reason: "incompatible", status: 409 });

    const refused = await POST(request({}), { params: Promise.resolve({ id: "task-1" }) });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({ error: "圧縮に失敗しました" });

    mocks.forwardTaskCompact.mockResolvedValue({ ok: false, reason: "timeout" });
    expect((await POST(request({}), { params: Promise.resolve({ id: "task-1" }) })).status).toBe(502);
    expect(mocks.compactTask).not.toHaveBeenCalled();
  });
});
