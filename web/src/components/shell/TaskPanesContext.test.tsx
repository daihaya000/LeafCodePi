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

function RetargetHomeProbe() {
  const { retargetToUrl } = useTaskPanes();
  return (
    <button
      onClick={() => {
        window.history.pushState(null, "", "/?projectId=project-1");
        retargetToUrl("home");
      }}
    >
      open project home
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

  it("restores Bot routes, titles and closes only deleted Bot tabs", async () => {
    matches = true;
    localStorage.setItem(TASK_PANES_STORAGE_KEY, JSON.stringify({ version: 1, panes: [{ id: "first-pane", tabs: ["second", "/bots/one"], activeTabId: "second" }], activePaneId: "first-pane" }));
    mocks.usePathname.mockReturnValue("/bots/one");
    mocks.getJson.mockImplementation(async (url: string) => url === "/api/bots/sidebar" ? { bots: [{ id: "one", name: "One" }], rooms: [] } : { tasks: [{ id: "second", title: "Code", status: "idle" }] });
    function BotProbe() {
      const { titleFor, dispatch } = useTaskPanes();
      return <button onClick={() => dispatch({ type: "activateTab", paneId: "first-pane", taskId: "/bots/one" })}>{titleFor("/bots/one") ?? "loading"}</button>;
    }
    render(<TaskPanesProvider><Probe /><BotProbe /><DispatchProbe /></TaskPanesProvider>);
    await screen.findByRole("button", { name: "One" });
    fireEvent.click(screen.getByRole("button", { name: "activate second" }));
    await waitFor(() => expect(window.location.pathname).toBe("/task/second"));
    fireEvent.click(screen.getByRole("button", { name: "One" }));
    await waitFor(() => expect(window.location.pathname).toBe("/bots/one"));
    expect(screen.getByTestId("state").textContent).toBe("true:second,/bots/one");
    mocks.getJson.mockResolvedValue({ bots: [], rooms: [] });
    window.dispatchEvent(new Event("webui:bot-sidebar-changed"));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("true:second"));
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

  it("デスクトップからモバイルを経由してもペインとURLを保持する", async () => {
    matches = true;
    mocks.usePathname.mockReturnValue("/task/saved-task");
    window.history.replaceState(null, "", "/task/saved-task");

    render(
      <TaskPanesProvider>
        <Probe />
      </TaskPanesProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("true:saved-task");
    });
    expect(window.location.pathname).toBe("/task/saved-task");

    matches = false;
    for (const listener of mediaListeners) listener(new Event("change") as MediaQueryListEvent);
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("false:saved-task");
    });
    expect(window.location.pathname).toBe("/task/saved-task");

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

  it("プロジェクト付きHomeへのネイティブ遷移でqueryを保持する", async () => {
    matches = true;

    render(
      <TaskPanesProvider>
        <ActiveTabProbe />
        <RetargetHomeProbe />
      </TaskPanesProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("saved-task");
    });

    fireEvent.click(screen.getByRole("button", { name: "open project home" }));
    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("home");
    });
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?projectId=project-1");
  });

  it("keeps an archived history tab after an unrelated tasks-changed event", async () => {
    matches = true;
    mocks.getJson.mockResolvedValue({
      tasks: [
        { id: "live-task", title: "live", status: "idle" },
        { id: "archived-task", title: "old", status: "archived" },
      ],
    });
    localStorage.setItem(
      TASK_PANES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        panes: [{ id: "saved-pane", tabs: ["archived-task"], activeTabId: "archived-task" }],
        activePaneId: "saved-pane",
      }),
    );

    render(
      <TaskPanesProvider>
        <Probe />
      </TaskPanesProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("true:archived-task");
    });
    window.dispatchEvent(new Event("webui:tasks-changed"));
    await waitFor(() => {
      expect(mocks.getJson.mock.calls.length).toBeGreaterThan(1);
    });
    expect(screen.getByTestId("state").textContent).toBe("true:archived-task");
    expect(mocks.getJson).toHaveBeenCalledWith("/api/tasks", {
      titles: "1",
      archived: "1",
    });
  });

  it("closes a tab after it changes from live to archived", async () => {
    matches = true;
    mocks.getJson
      .mockResolvedValueOnce({
        tasks: [{ id: "live-task", title: "live", status: "idle" }],
      })
      .mockResolvedValue({
        tasks: [{ id: "live-task", title: "live", status: "archived" }],
      });
    localStorage.setItem(
      TASK_PANES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        panes: [{ id: "saved-pane", tabs: ["live-task"], activeTabId: "live-task" }],
        activePaneId: "saved-pane",
      }),
    );

    render(
      <TaskPanesProvider>
        <Probe />
      </TaskPanesProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("true:live-task");
    });
    window.dispatchEvent(new Event("webui:tasks-changed"));
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("true:");
    });
  });
});
