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

import { TaskPanesProvider, useBotFor, useBotStatusFor, useIconFor, useTaskPanes, useTaskPanesNavigation } from "./TaskPanesContext";

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

  it("does not rerender stable service consumers for status updates", () => {
    const stableRenderSpy = vi.fn();
    const botStatusRenderSpy = vi.fn();
    const navigationRenderSpy = vi.fn();
    function StableServiceProbe() {
      useBotFor();
      stableRenderSpy();
      return null;
    }
    function BotStatusProbe() {
      useBotStatusFor();
      botStatusRenderSpy();
      return null;
    }
    function NavigationProbe() {
      useTaskPanesNavigation();
      navigationRenderSpy();
      return null;
    }
    function StatusProbe() {
      const { reportStatus } = useTaskPanes();
      return <>
        <button onClick={() => reportStatus("task-1", "working")}>report status</button>
        <button onClick={() => reportStatus("/bots/one", "working")}>report bot status</button>
      </>;
    }

    render(
      <TaskPanesProvider>
        <StableServiceProbe />
        <BotStatusProbe />
        <NavigationProbe />
        <StatusProbe />
      </TaskPanesProvider>,
    );
    const initialStableRenderCount = stableRenderSpy.mock.calls.length;
    const initialBotStatusRenderCount = botStatusRenderSpy.mock.calls.length;
    const initialNavigationRenderCount = navigationRenderSpy.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "report status" }));
    expect(stableRenderSpy.mock.calls.length).toBe(initialStableRenderCount);
    expect(botStatusRenderSpy.mock.calls.length).toBe(initialBotStatusRenderCount);
    expect(navigationRenderSpy.mock.calls.length).toBe(initialNavigationRenderCount);
    fireEvent.click(screen.getByRole("button", { name: "report bot status" }));
    expect(stableRenderSpy.mock.calls.length).toBe(initialStableRenderCount);
    expect(botStatusRenderSpy.mock.calls.length).toBe(initialBotStatusRenderCount + 1);
    expect(navigationRenderSpy.mock.calls.length).toBe(initialNavigationRenderCount);
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

  it.each([false, true])("renders project and Bot icons and refreshes edits (desktop=%s)", async (desktop) => {
    matches = desktop;
    let projectIcon: string | null = "data:image/png;base64,project";
    let botImage = "data:image/png;base64,bot";
    const paneRenderSpy = vi.fn();
    mocks.getJson.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/projects")) return { projects: [{ id: "project", name: "Project", icon: projectIcon }] };
      if (url === "/api/bots/sidebar") return { bots: [{ id: "one", name: "One", avatarImage: botImage }], rooms: [] };
      return { tasks: [{ id: "saved-task", title: "Code", status: "idle", projectId: "project" }] };
    });
    function PaneProbe() {
      useTaskPanes();
      paneRenderSpy();
      return null;
    }
    function IconProbe() {
      const iconFor = useIconFor();
      return <>
        <div data-testid="tab-icon">{iconFor("saved-task")}</div>
        <div data-testid="header-icon">{iconFor("saved-task", 32, { projectId: "project" })}</div>
        <div data-testid="bot-tab-icon">{iconFor("/bots/one")}</div>
        <div data-testid="bot-header-icon">{iconFor("code", 32, { projectId: "project", botId: "one" })}</div>
        <div data-testid="no-icon">{iconFor("settings")}{iconFor("unassigned", 32, { projectId: null })}</div>
      </>;
    }
    render(<TaskPanesProvider><PaneProbe /><IconProbe /></TaskPanesProvider>);
    const image = (id: string) => screen.getByTestId(id).querySelector("img")?.getAttribute("src");
    await waitFor(() => {
      expect(image("header-icon")).toBe(projectIcon);
      if (desktop) expect(image("tab-icon")).toBe(projectIcon);
      expect(image("bot-tab-icon")).toBe(botImage);
      expect(image("bot-header-icon")).toBe(botImage);
    });
    expect(screen.getByTestId("no-icon").innerHTML).toBe("");
    const paneRenderCountAfterInitialData = paneRenderSpy.mock.calls.length;
    projectIcon = null;
    botImage = "data:image/png;base64,updated";
    window.dispatchEvent(new Event("webui:tasks-changed"));
    window.dispatchEvent(new Event("webui:bot-sidebar-changed"));
    await waitFor(() => {
      expect(screen.getByTestId("header-icon").textContent).toBe("P");
      expect(image("bot-tab-icon")).toBe(botImage);
      expect(image("bot-header-icon")).toBe(botImage);
    });
    expect(paneRenderSpy.mock.calls.length).toBe(paneRenderCountAfterInitialData);
  });

  it.each([null, "data:image/png;base64,bot"])("animates Bot icons only while working (%s)", async (avatarImage) => {
    mocks.getJson.mockImplementation(async (url: string) => url.startsWith("/api/projects")
      ? { projects: [] }
      : { bots: [{ id: "one", name: "One", avatarImage }], rooms: [] });
    function ActivityProbe() {
      const iconFor = useIconFor();
      const { reportStatus, statusFor } = useTaskPanes();
      return <>
        {iconFor("/bots/one")}
        {iconFor("code", 32, { projectId: null, botId: "one", status: statusFor("/bots/one") ?? "idle" })}
        {(["working", "idle", "error", "ready"] as const).map((status) =>
          <button key={status} onClick={() => reportStatus("/bots/one", status)}>{status}</button>)}
      </>;
    }
    const { container } = render(<TaskPanesProvider><ActivityProbe /></TaskPanesProvider>);
    await waitFor(() => expect(container.querySelectorAll("svg, img")).toHaveLength(2));
    expect(container.querySelectorAll(".bot-avatar-working")).toHaveLength(0);
    for (const status of ["idle", "error", "ready"]) {
      fireEvent.click(screen.getByRole("button", { name: "working" }));
      expect(container.querySelectorAll(".bot-avatar-working")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: status }));
      expect(container.querySelectorAll(".bot-avatar-working")).toHaveLength(0);
    }
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
    let taskRequests = 0;
    mocks.getJson.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/projects")) return { projects: [] };
      if (url === "/api/bots/sidebar") return { bots: [], rooms: [] };
      return { tasks: [{ id: "live-task", title: "live", status: taskRequests++ === 0 ? "idle" : "archived" }] };
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
