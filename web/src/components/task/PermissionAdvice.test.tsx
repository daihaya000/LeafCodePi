// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
