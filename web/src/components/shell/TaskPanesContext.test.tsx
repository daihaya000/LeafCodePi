// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_PANES_STORAGE_KEY } from "@/lib/task-panes";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  usePathname: vi.fn(() => "/"),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson }));
vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));

import { TaskPanesProvider, useTaskPanes } from "./TaskPanesContext";

function Probe() {
  const { state, mdUp } = useTaskPanes();
  return (
    <output data-testid="state">
      {`${mdUp}:${state.panes[0]?.tabs.join(",") ?? ""}`}
    </output>
  );
}

describe("TaskPanesProvider", () => {
  let matches = false;
  let mediaListeners: Array<(event: MediaQueryListEvent) => void>;

  beforeEach(() => {
    matches = false;
    mediaListeners = [];
    window.history.replaceState(null, "", "/");
    mocks.getJson.mockReset().mockRejectedValue(new Error("not used"));
    mocks.usePathname.mockReturnValue("/");
    localStorage.clear();
    localStorage.setItem(
      TASK_PANES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        panes: [{ id: "saved-pane", tabs: ["saved-task"], activeTabId: "saved-task" }],
        activePaneId: "saved-pane",
      }),
    );
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      media: "(min-width: 768px)",
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners.push(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        mediaListeners = mediaListeners.filter((item) => item !== listener);
      },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("restores saved panes when the viewport changes from mobile to desktop", async () => {
    render(
      <TaskPanesProvider>
        <Probe />
      </TaskPanesProvider>,
    );

    expect(screen.getByTestId("state").textContent).toBe("false:home");

    matches = true;
    for (const listener of mediaListeners) listener(new Event("change") as MediaQueryListEvent);

    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("true:saved-task");
    });
  });

  it("root URL から保存済みタスクを復元した場合はURLも追従する", async () => {
    matches = true;

    render(
      <TaskPanesProvider>
        <Probe />
      </TaskPanesProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("true:saved-task");
    });
    expect(window.location.pathname).toBe("/task/saved-task");
  });
});
