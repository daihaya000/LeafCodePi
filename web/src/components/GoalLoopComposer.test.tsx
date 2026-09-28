// @vitest-environment happy-dom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GoalLoopOptions, GoalLoopToggle } from "./GoalLoopComposer";

const options = {
  acceptance: "テストが通ること",
  maxTurns: 10,
  cooldownSeconds: 30,
  forceFullRun: false,
  onAcceptanceChange: vi.fn(),
  onMaxTurnsChange: vi.fn(),
  onCooldownSecondsChange: vi.fn(),
  onForceFullRunChange: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("always displays settings with a non-interactive heading and retains draft normalization", () => {
  const { container, rerender } = render(<GoalLoopOptions {...options} />);
  const section = screen.getByRole("region", { name: "ループ設定" });
  expect(section.textContent).toContain("10ターン · 待機 30s · 承認条件あり");
  expect(container.querySelector("details, summary")).toBeNull();

  const turns = screen.getByLabelText("最大ターン数") as HTMLInputElement;
  fireEvent.change(turns, { target: { value: "" } });
  fireEvent.blur(turns);
  expect(turns.value).toBe("1");
  expect(options.onMaxTurnsChange).toHaveBeenCalledWith(1);
  const cooldown = screen.getByLabelText("クールタイム") as HTMLInputElement;
  fireEvent.change(cooldown, { target: { value: "2m 5s" } });
  fireEvent.keyDown(cooldown, { key: "Enter" });
  expect(cooldown.value).toBe("2m 5s");
  expect(options.onCooldownSecondsChange).toHaveBeenCalledWith(125);
  fireEvent.change(screen.getByLabelText("承認条件"), { target: { value: "確認済み" } });
  expect(options.onAcceptanceChange).toHaveBeenCalledWith("確認済み");

  rerender(<GoalLoopOptions {...options} maxTurns={20} />);
  expect(section.textContent).toContain("20ターン");
  expect(screen.getByLabelText("最大ターン数")).toBeTruthy();
});

it("shows settings only while the loop button is enabled", () => {
  function LoopComposer() {
    const [enabled, setEnabled] = useState(false);
    return (
      <>
        <GoalLoopToggle enabled={enabled} onToggle={() => setEnabled((value) => !value)} />
        {enabled && <GoalLoopOptions {...options} />}
      </>
    );
  }

  render(<LoopComposer />);
  const toggle = screen.getByRole("button", { name: "ループで継続実行" });
  expect(toggle.textContent).toBe("");
  expect(toggle.querySelector("svg.lucide-infinity")).toBeTruthy();
  expect(toggle.className).toContain("h-9 w-9");
  expect(toggle.className).toContain("!rounded-full");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByRole("region", { name: "ループ設定" })).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", { name: "ループ設定" })).toBeTruthy();
  expect(screen.getByLabelText("最大ターン数")).toBeTruthy();
  fireEvent.click(toggle);
  expect(screen.queryByRole("region", { name: "ループ設定" })).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole("region", { name: "ループ設定" })).toBeTruthy();
});

it("summarizes unlimited full runs and preserves disabled controls", () => {
  const { container, rerender } = render(<GoalLoopOptions {...options} />);
  fireEvent.click(screen.getByLabelText("完走モード"));
  expect(options.onForceFullRunChange).toHaveBeenCalledWith(true);

  rerender(<GoalLoopOptions {...options} maxTurns={0} forceFullRun disabled />);
  expect(screen.getByRole("region", { name: "ループ設定" }).textContent).toContain("無制限 · 待機 30s · 完走");
  expect(screen.queryByLabelText("承認条件")).toBeNull();
  for (const input of container.querySelectorAll("input")) expect(input.disabled).toBe(true);
});
