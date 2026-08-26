// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_PANES_STORAGE_KEY } from "@/lib/task-panes";

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  retargetActiveTab: vi.fn(),
  usePathname: vi.fn(() => "/"),
}));

vi.mock("@/lib/client", () => ({ getJson: mocks.getJson }));
vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));
vi.mock("@/lib/task-panes", async () => {
  const actual = await vi.importActual<typeof import("@/lib/task-panes")>("@/lib/task-panes");
  return {
    ...actual,
    retargetActiveTab: (...args: Parameters<typeof actual.retargetActiveTab>) => {
      mocks.retargetActiveTab(...args);
      return actual.retargetActiveTab(...args);
    },
  };
});

import { TaskPanesProvider, useTaskPanes } from "./TaskPanesContext";

function Probe() {
  const { state, mdUp } = useTaskPanes();
  return (
    <output data-testid="state">
      {`${mdUp}:${state.panes[0]?.tabs.join(",") ?? ""}`}
    </output>
  );
}

function ActivePaneProbe() {
  const { state } = useTaskPanes();
  return <output data-testid="active-pane">{state.activePaneId}</output>;
}

function ActiveTabProbe() {
  const { state } = useTaskPanes();
  return <output data-testid="active-tab">{state.panes[0]?.activeTabId}</output>;
}

function DispatchProbe() {
  const { dispatch } = useTaskPanes();
  return (
    <button onClick={() => dispatch({ type: "activateTab", paneId: "first-pane", taskId: "second" })}>
      activate second
    </button>
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

  it("外部URL変更時は対象タスクのあるペインをアクティブにする", async () => {
    matches = true;
    mocks.usePathname.mockReturnValue("/task/first");
    localStorage.setItem(
      TASK_PANES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        panes: [
          { id: "first-pane", tabs: ["first"], activeTabId: "first" },
          { id: "second-pane", tabs: ["second"], activeTabId: "second" },
        ],
        activePaneId: "first-pane",
      }),
    );

    const renderView = () => (
      <TaskPanesProvider>
        <Probe />
        <ActivePaneProbe />
      </TaskPanesProvider>
    );
    const { rerender } = render(renderView());

    await waitFor(() => {
      expect(screen.getByTestId("active-pane").textContent).toBe("first-pane");
    });

    mocks.usePathname.mockReturnValue("/task/second");
    rerender(renderView());

    await waitFor(() => {
      expect(screen.getByTestId("active-pane").textContent).toBe("second-pane");
    });
    expect(window.location.pathname).toBe("/task/second");
  });

  it("内部タブ切替後は外部retargetを二重適用しない", async () => {
    matches = true;
    mocks.usePathname.mockReturnValue("/task/first");
    localStorage.setItem(
      TASK_PANES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        panes: [{ id: "first-pane", tabs: ["first", "second"], activeTabId: "first" }],
        activePaneId: "first-pane",
      }),
    );

    const renderView = () => (
      <TaskPanesProvider>
        <ActiveTabProbe />
        <DispatchProbe />
      </TaskPanesProvider>
    );
    const { rerender } = render(renderView());

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("first");
    });
    mocks.retargetActiveTab.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "activate second" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("second");
    });

    mocks.usePathname.mockReturnValue("/task/second");
    rerender(renderView());
    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("second");
    });
    expect(mocks.retargetActiveTab).not.toHaveBeenCalled();
  });
});
