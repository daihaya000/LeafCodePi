// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GoalLoopOptions } from "./GoalLoopComposer";

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

it("starts collapsed with a settings summary and retains draft normalization", () => {
  const { container } = render(<GoalLoopOptions {...options} />);
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")?.textContent).toContain("10ターン · 待機 30s · 承認条件あり");
  fireEvent.click(details.querySelector("summary")!);

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
});

it("summarizes unlimited full runs and preserves disabled controls", () => {
  const { container, rerender } = render(<GoalLoopOptions {...options} />);
  fireEvent.click(screen.getByLabelText("完走モード"));
  expect(options.onForceFullRunChange).toHaveBeenCalledWith(true);

  rerender(<GoalLoopOptions {...options} maxTurns={0} forceFullRun disabled />);
  expect(container.querySelector("summary")?.textContent).toContain("無制限 · 待機 30s · 完走");
  expect(screen.queryByLabelText("承認条件")).toBeNull();
  for (const input of container.querySelectorAll("input")) expect(input.disabled).toBe(true);
});
