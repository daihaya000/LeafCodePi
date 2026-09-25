// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeArchiveRow } from "./SwipeArchiveRow";

afterEach(cleanup);

function setup() {
  const onArchive = vi.fn();
  const onOpen = vi.fn();
  const onNativeDrag = vi.fn();
  const view = render(
    <SwipeArchiveRow label="タスクをアーカイブ" onArchive={onArchive}>
      <button draggable onDragStart={onNativeDrag} onClick={onOpen}>タスクを開く</button>
    </SwipeArchiveRow>,
  );
  const foreground = screen.getByRole("button", { name: "タスクを開く" }).parentElement!;
  const row = foreground.parentElement!;
  return { row, foreground, onArchive, onOpen, onNativeDrag, action: screen.getByRole("button", { name: "タスクをアーカイブ" }), ...view };
}

describe("SwipeArchiveRow", () => {
  it("hides the destructive action completely even when disabled", () => {
    render(<SwipeArchiveRow label="無効なアーカイブ" disabled onArchive={vi.fn()}><span>行</span></SwipeArchiveRow>);
    const action = screen.getByRole("button", { name: "無効なアーカイブ" });
    expect(action.style.opacity).toBe("0");
    expect(action.className).toContain("pointer-events-none");
  });

  it("keeps the action covered until a left swipe and closes it on a right swipe", () => {
    const { row, foreground, action, onArchive, onOpen } = setup();
    expect(foreground.style.transform).toBe("translateX(-0px)");
    expect(action.style.opacity).toBe("0");
    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 38, clientY: 52 }] });
    fireEvent.touchEnd(row);
    expect(foreground.style.transform).toBe("translateX(-64px)");
    expect(action.style.opacity).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "タスクを開く" })); // Synthetic click from the swipe.
    expect(onOpen).not.toHaveBeenCalled();
    expect(foreground.style.transform).toBe("translateX(-64px)");
    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchEnd(row);
    fireEvent.click(screen.getByRole("button", { name: "タスクを開く" })); // Separate tap closes it.
    expect(onOpen).not.toHaveBeenCalled();
    expect(foreground.style.transform).toBe("translateX(-0px)");

    fireEvent.touchStart(row, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchEnd(row);
    fireEvent.click(action); // A swipe ending over the destructive button must not archive.
    expect(onArchive).not.toHaveBeenCalled();
    expect(foreground.style.transform).toBe("translateX(-64px)");
    fireEvent.touchStart(action, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchEnd(action);
    fireEvent.click(action);
    expect(onArchive).toHaveBeenCalledTimes(1);

    fireEvent.touchStart(action, { touches: [{ clientX: 20, clientY: 50 }] });
    fireEvent.touchMove(action, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchEnd(action);
    fireEvent.click(action); // A swipe to close must not archive either.
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(foreground.style.transform).toBe("translateX(-0px)");
  });

  it("opens with a desktop mouse drag without triggering a row click or native drag", () => {
    const { row, foreground, action, onOpen, onArchive, onNativeDrag } = setup();
    fireEvent.pointerDown(row, { pointerType: "mouse", pointerId: 1, button: 0, clientX: 110, clientY: 20 });
    fireEvent.pointerMove(row, { pointerType: "mouse", pointerId: 1, clientX: 108, clientY: 20 });
    const nativeDrag = new Event("dragstart", { bubbles: true, cancelable: true });
    expect(screen.getByRole("button", { name: "タスクを開く" }).dispatchEvent(nativeDrag)).toBe(false);
    expect(onNativeDrag).not.toHaveBeenCalled();
    fireEvent.pointerMove(row, { pointerType: "mouse", pointerId: 1, clientX: 45, clientY: 21 });
    fireEvent.pointerUp(row, { pointerType: "mouse", pointerId: 1, clientX: 45, clientY: 21 });
    fireEvent.click(action); // Mouse release over the action must not archive it.
    expect(onArchive).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(foreground.style.transform).toBe("translateX(-64px)");
    fireEvent.pointerDown(row, { pointerType: "mouse", pointerId: 2, button: 0, clientX: 45, clientY: 20 });
    fireEvent.pointerMove(row, { pointerType: "mouse", pointerId: 2, clientX: 110, clientY: 20 });
    fireEvent.pointerUp(row, { pointerType: "mouse", pointerId: 2, clientX: 110, clientY: 20 });
    expect(foreground.style.transform).toBe("translateX(-0px)");
    expect(action.style.opacity).toBe("0");
    fireEvent.pointerDown(row, { pointerType: "mouse", pointerId: 3, button: 0, clientX: 45, clientY: 20 });
    fireEvent.pointerMove(row, { pointerType: "mouse", pointerId: 3, clientX: 46, clientY: 80 });
    expect(screen.getByRole("button", { name: "タスクを開く" }).dispatchEvent(
      new Event("dragstart", { bubbles: true, cancelable: true }),
    )).toBe(true); // Vertical native DnD remains available.
    expect(onNativeDrag).toHaveBeenCalledTimes(1);
    fireEvent.pointerCancel(row, { pointerType: "mouse", pointerId: 3 });
  });

  it("ignores vertical scrolling and supports keyboard focus and horizontal trackpad scrolling", () => {
    const { row, foreground, action } = setup();
    expect(row.lastElementChild).toBe(action); // Keep the action after the row controls in tab order.
    expect(foreground.className).toContain("bg-surface");
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
