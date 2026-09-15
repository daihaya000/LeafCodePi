import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compactTask: vi.fn(),
  jsonError: vi.fn((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
    status: 500,
  })),
}));

vi.mock("@/lib/pi/harness", () => mocks);

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
});
