import { describe, expect, it, vi } from "vitest";
import {
  isTaskDrag,
  setTaskDragData,
  taskDragIdFrom,
  TASK_DRAG_MIME,
} from "./task-drag";

function fakeDataTransfer(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    setData: vi.fn((mime: string, value: string) => {
      values[mime] = value;
    }),
    getData: vi.fn((mime: string) => values[mime] ?? ""),
  } as unknown as DataTransfer;
}

describe("task drag MIME helpers", () => {
  it("stores the task id under the custom MIME and text/plain", () => {
    const dataTransfer = fakeDataTransfer();
    setTaskDragData(dataTransfer, "task-1");
    expect(dataTransfer.setData).toHaveBeenCalledWith(TASK_DRAG_MIME, "task-1");
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "task-1");
  });

  it("detects the drag by MIME type", () => {
    expect(isTaskDrag([TASK_DRAG_MIME])).toBe(true);
    expect(isTaskDrag(["text/plain"])).toBe(false);
    expect(isTaskDrag([])).toBe(false);
  });

  it("reads the task id from the custom MIME", () => {
    const dataTransfer = fakeDataTransfer({ [TASK_DRAG_MIME]: "task-1" });
    expect(taskDragIdFrom(dataTransfer)).toBe("task-1");
  });

  it("falls back to text/plain when the custom MIME is missing", () => {
    const dataTransfer = fakeDataTransfer({ "text/plain": "task-2" });
    expect(taskDragIdFrom(dataTransfer)).toBe("task-2");
  });

  it("returns null when nothing usable is present", () => {
    const dataTransfer = fakeDataTransfer({});
    expect(taskDragIdFrom(dataTransfer)).toBeNull();
  });
});