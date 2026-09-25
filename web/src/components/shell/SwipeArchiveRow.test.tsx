// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeArchiveRow } from "./SwipeArchiveRow";

afterEach(cleanup);

function setup() {
  const onArchive = vi.fn();
  const onOpen = vi.fn();
  const view = render(
    <SwipeArchiveRow label="タスクをアーカイブ" onArchive={onArchive}>
      <button onClick={onOpen}>タスクを開く</button>
    </SwipeArchiveRow>,
  );
  const foreground = screen.getByRole("button", { name: "タスクを開く" }).parentElement!;
  const row = foreground.parentElement!;
  return { row, foreground, onArchive, onOpen, action: screen.getByRole("button", { name: "タスクをアーカイブ" }), ...view };
}

describe("SwipeArchiveRow", () => {
  it("keeps the action covered until a left swipe and closes it on a right swipe", () => {
    const { row, foreground, action, onArchive, onOpen } = setup();
    expect(foreground.style.transform).toBe("translateX(-0px)");
    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 38, clientY: 52 }] });
    fireEvent.touchEnd(row);
    expect(foreground.style.transform).toBe("translateX(-64px)");
    fireEvent.click(screen.getByRole("button", { name: "タスクを開く" }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(foreground.style.transform).toBe("translateX(-0px)");

    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchEnd(row);
    fireEvent.click(action);
    expect(onArchive).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(row, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchEnd(row);
    expect(foreground.style.transform).toBe("translateX(-0px)");
  });

  it("ignores vertical scrolling and supports keyboard focus and horizontal trackpad scrolling", () => {
    const { row, foreground, action } = setup();
    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 10 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 85, clientY: 100 }] });
    fireEvent.touchEnd(row);
    expect(foreground.style.transform).toBe("translateX(-0px)");
    fireEvent.focus(action);
    expect(foreground.style.transform).toBe("translateX(-64px)");
    fireEvent.wheel(row, { deltaX: -40, deltaY: 0 });
    expect(foreground.style.transform).toBe("translateX(-0px)");
    fireEvent.wheel(row, { deltaX: 40, deltaY: 0 });
    expect(foreground.style.transform).toBe("translateX(-64px)");
  });
});
