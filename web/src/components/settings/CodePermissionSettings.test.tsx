// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PermissionModeSettings,
  SkillPermissionSettings,
  SubagentPermissionSettings,
} from "./CodePermissionSettings";

const { getJson, sendJson } = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson, sendJson }));

describe("CodePermissionSettings", () => {
  beforeEach(() => {
    getJson.mockResolvedValue({ value: null });
    sendJson.mockImplementation(async (_path: string, body: { value: string }) => ({ value: body.value }));
  });

  afterEach(() => {
    cleanup();
    getJson.mockReset();
    sendJson.mockReset();
  });

  it("shows allow / allow / deny when nothing is saved", async () => {
    render(
      <>
        <PermissionModeSettings />
        <SkillPermissionSettings />
        <SubagentPermissionSettings />
      </>,
    );
    const mode = screen.getByRole("combobox", { name: "権限承認" }) as HTMLSelectElement;
    const skill = screen.getByRole("switch", { name: "Codeタスクでスキルを使用する" });
    const subagent = screen.getByRole("switch", { name: "Codeタスクでサブエージェントを使用する" });
    await waitFor(() => expect(mode.disabled).toBe(false));
    await waitFor(() => expect((skill as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect((subagent as HTMLButtonElement).disabled).toBe(false));

    expect(mode.value).toBe("allow");
    expect(screen.getByText(/Bash \/ PowerShell \/ 画面操作/)).toBeTruthy();
    expect(skill.getAttribute("aria-checked")).toBe("true");
    expect(subagent.getAttribute("aria-checked")).toBe("false");
    expect(getJson).toHaveBeenCalledWith("/api/settings/code-permission-mode");
    expect(getJson).toHaveBeenCalledWith("/api/settings/code-skill-permission");
    expect(getJson).toHaveBeenCalledWith("/api/settings/code-subagent-permission");
  });

  it("saves the approval mode to Settings", async () => {
    getJson.mockResolvedValue({ value: "ask" });
    render(<PermissionModeSettings />);
    const mode = screen.getByRole("combobox", { name: "権限承認" }) as HTMLSelectElement;
    await waitFor(() => expect(mode.value).toBe("ask"));

    fireEvent.change(mode, { target: { value: "deny" } });

    await waitFor(() =>
      expect(sendJson).toHaveBeenCalledWith("/api/settings/code-permission-mode", { value: "deny" }, "PUT"),
    );
    expect(mode.value).toBe("deny");
  });

  it("toggles subagent use and skill use", async () => {
    render(
      <>
        <SkillPermissionSettings />
        <SubagentPermissionSettings />
      </>,
    );
    const skill = screen.getByRole("switch", { name: "Codeタスクでスキルを使用する" }) as HTMLButtonElement;
    const subagent = screen.getByRole("switch", { name: "Codeタスクでサブエージェントを使用する" }) as HTMLButtonElement;
    await waitFor(() => expect(subagent.disabled).toBe(false));
    await waitFor(() => expect(skill.disabled).toBe(false));

    fireEvent.click(subagent);
    await waitFor(() => expect(subagent.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(skill);
    await waitFor(() => expect(skill.getAttribute("aria-checked")).toBe("false"));

    expect(sendJson).toHaveBeenCalledWith("/api/settings/code-subagent-permission", { value: "allow" }, "PUT");
    expect(sendJson).toHaveBeenCalledWith("/api/settings/code-skill-permission", { value: "deny" }, "PUT");
  });

  it("restores the previous value when saving fails", async () => {
    sendJson.mockRejectedValue(new Error("保存できません"));
    render(<SubagentPermissionSettings />);
    const subagent = screen.getByRole("switch", { name: "Codeタスクでサブエージェントを使用する" }) as HTMLButtonElement;
    await waitFor(() => expect(subagent.disabled).toBe(false));

    fireEvent.click(subagent);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("保存できません"));
    expect(subagent.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the control disabled when the saved value cannot be read", async () => {
    getJson.mockRejectedValue(new Error("読み込めません"));
    render(<PermissionModeSettings />);
    const mode = screen.getByRole("combobox", { name: "権限承認" }) as HTMLSelectElement;

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("読み込めません"));
    expect(mode.disabled).toBe(true);
    expect(sendJson).not.toHaveBeenCalled();
  });
});
