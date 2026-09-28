// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/client";
import { PermissionAdvice } from "./PermissionAdvice";

const mocks = vi.hoisted(() => ({ sendJson: vi.fn() }));

vi.mock("@/lib/client", () => ({
  ApiError: class ApiError extends Error {
    status = 500;
  },
  sendJson: mocks.sendJson,
}));

describe("PermissionAdvice", () => {
  beforeEach(() => {
    mocks.sendJson.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("explains that advice was skipped to avoid competing with the local agent", async () => {
    const error = new ApiError("エージェントが llama-server を使用中のため busy", 409);
    error.status = 409;
    mocks.sendJson.mockRejectedValue(error);

    render(<PermissionAdvice taskId="task-1" requestId="request-busy" />);

    expect(await screen.findByText(/エージェントがローカルLLMを使用中のため第三者アドバイスを生成できません/)).toBeTruthy();
  });

  it("does not mislabel other conflicts as a local-LLM contention", async () => {
    mocks.sendJson.mockRejectedValue(new ApiError("アカウントが一時停止中です", 409));

    render(<PermissionAdvice taskId="task-1" requestId="request-conflict" />);

    expect(await screen.findByText(/第三者アドバイスを取得できませんでした/)).toBeTruthy();
  });

  it("shows the generated advice and model", async () => {
    mocks.sendJson.mockResolvedValue({
      advice: "対象と影響範囲を確認してから判断してください。",
      model: { providerID: "opencode-go", modelID: "mimo-v2.5" },
    });

    render(<PermissionAdvice taskId="task-1" requestId="request-1" />);

    expect(await screen.findByText("対象と影響範囲を確認してから判断してください。")).toBeTruthy();
    expect(screen.getByText("第三者アドバイス")).toBeTruthy();
    expect(screen.getByText("mimo-v2.5")).toBeTruthy();
    expect(mocks.sendJson).toHaveBeenCalledWith(
      "/api/tasks/task-1/permission/advice",
      { requestId: "request-1" },
      "POST",
      expect.objectContaining({ timeoutMs: 35_000 }),
    );
  });
});
