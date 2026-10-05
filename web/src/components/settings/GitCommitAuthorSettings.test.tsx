// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCommitAuthorSettings } from "./GitCommitAuthorSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));

vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("GitCommitAuthorSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ value: null, machineName: "x870" });
    sendJson.mockResolvedValue({ value: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the default author format and supports custom templates", async () => {
    render(<GitCommitAuthorSettings />);

    const name = await screen.findByLabelText("作者名テンプレート") as HTMLInputElement;
    const email = screen.getByLabelText("メールテンプレート") as HTMLInputElement;
    expect(name.value).toBe("{agent}");
    expect(email.value).toBe("{agent}@leafcodepi.{machine}");
    expect(screen.getByLabelText("コミット作者プレビュー").textContent)
      .toBe("default <default@leafcodepi.x870>");

    fireEvent.change(name, { target: { value: "Agent ({agent})" } });
    fireEvent.change(email, { target: { value: "{agent}@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/git-commit-author",
      { value: JSON.stringify({ nameTemplate: "Agent ({agent})", emailTemplate: "{agent}@example.test" }) },
      "PUT",
    ));
  });

  it("resets the server setting to its defaults", async () => {
    render(<GitCommitAuthorSettings />);
    await screen.findByLabelText("作者名テンプレート");
    fireEvent.click(screen.getByRole("button", { name: "既定に戻す" }));

    await waitFor(() => expect(sendJson).toHaveBeenCalledWith(
      "/api/settings/git-commit-author",
      { value: null },
      "PUT",
    ));
  });
});
