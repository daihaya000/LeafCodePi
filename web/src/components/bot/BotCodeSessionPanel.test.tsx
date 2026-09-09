// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), sendJson: vi.fn() }));
vi.mock("@/lib/client", () => mocks);
vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <span>{children}</span> }));

import { BotCodeSessionPanel } from "./BotCodeSessionPanel";

const project = {
  id: "project-1",
  name: "Project",
  rootPath: "/tmp/project",
  favorite: false,
  archived: false,
  createdAt: "",
  lastOpenedAt: null,
};
const oldTask = {
  id: "old-task",
  projectId: null,
  projectName: "",
  title: "Old task",
  directory: "",
  isolation: "current_folder" as const,
  status: "ready" as const,
  sessionId: null,
  sessionFile: null,
  createdAt: "",
  updatedAt: "",
};
const newTask = { ...oldTask, id: "new-task", title: "New task" };

beforeEach(() => {
  mocks.getJson.mockReset();
  mocks.sendJson.mockReset();
});
afterEach(() => cleanup());

it("ignores a stale session response after switching bot ids", async () => {
  let resolveOld!: (value: { tasks: typeof oldTask[] }) => void;
  const oldResponse = new Promise<{ tasks: typeof oldTask[] }>((resolve) => { resolveOld = resolve; });
  mocks.getJson.mockImplementation((url: string) => {
    if (url === "/api/bots/one/code-session") return oldResponse;
    if (url === "/api/bots/two/code-session") return Promise.resolve({ tasks: [newTask] });
    if (url === "/api/projects") return Promise.resolve({ projects: [project] });
    return Promise.resolve({ loop: null });
  });

  const view = render(<BotCodeSessionPanel botId="one" />);
  view.rerender(<BotCodeSessionPanel botId="two" />);
  await waitFor(() => expect(mocks.getJson).toHaveBeenCalledWith("/api/bots/two/code-session"));
  expect(await screen.findByText("New task")).toBeTruthy();

  await act(async () => {
    resolveOld({ tasks: [oldTask] });
    await oldResponse;
  });

  expect(screen.getByText("New task")).toBeTruthy();
  expect(screen.queryByText("Old task")).toBeNull();
});
