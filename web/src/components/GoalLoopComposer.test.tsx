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

it("starts expanded with a settings summary and retains draft normalization", () => {
  const { container, rerender } = render(<GoalLoopOptions {...options} />);
  const details = container.querySelector("details")!;
  expect(details.open).toBe(true);
  expect(details.querySelector("summary")?.textContent).toContain("10ターン · 待機 30s · 承認条件あり");

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

  fireEvent.click(details.querySelector("summary")!);
  expect(details.open).toBe(false);
  rerender(<GoalLoopOptions {...options} maxTurns={20} />);
  expect(details.open).toBe(false);
});

it("opens settings when the loop button is enabled and respects manual collapse", () => {
  function LoopComposer() {
    const [enabled, setEnabled] = useState(false);
    return (
      <>
        <GoalLoopToggle enabled={enabled} onToggle={() => setEnabled((value) => !value)} />
        {enabled && <GoalLoopOptions {...options} />}
      </>
    );
  }

  const { container } = render(<LoopComposer />);
  const toggle = screen.getByRole("button", { name: "ループで継続実行" });
  expect(container.querySelector("details")).toBeNull();
  fireEvent.click(toggle);
  const details = container.querySelector("details")!;
  expect(details.open).toBe(true);
  fireEvent.click(details.querySelector("summary")!);
  expect(details.open).toBe(false);
  fireEvent.click(toggle);
  expect(container.querySelector("details")).toBeNull();
  fireEvent.click(toggle);
  expect(container.querySelector("details")?.open).toBe(true);
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
