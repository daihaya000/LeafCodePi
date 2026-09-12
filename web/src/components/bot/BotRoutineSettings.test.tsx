// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sendJson: vi.fn() }));
vi.mock("@/lib/client", () => ({ sendJson: mocks.sendJson }));
import { BotRoutineSettings } from "./BotRoutineSettings";

const routine = {
  id: "routine-1", botId: "one", name: "朝の確認", prompt: "Check status", schedule: "0 * * * *",
  enabled: true, createdAt: "", updatedAt: "", failureCount: 0, lastRunAt: null,
};

beforeEach(() => {
  mocks.sendJson.mockReset();
  mocks.sendJson.mockResolvedValue({ routine });
});
afterEach(() => { cleanup(); });

it("edits a routine from the regular settings panel", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<BotRoutineSettings botId="one" routines={[routine]} onRefresh={refresh} onError={vi.fn()} />);

  fireEvent.click(screen.getByRole("button", { name: "編集" }));
  fireEvent.change(screen.getByRole("textbox", { name: "ルーティン名" }), { target: { value: "夕方の確認" } });
  fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));

  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    "/api/bots/one/routines/routine-1",
    { name: "夕方の確認", prompt: "Check status", schedule: "0 * * * *" },
    "PATCH",
  ));
  expect(refresh).toHaveBeenCalled();
});

it("pauses a routine and keeps test execution available only while enabled", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<BotRoutineSettings botId="one" routines={[{ ...routine, enabled: false }]} onRefresh={refresh} onError={vi.fn()} />);

  expect((screen.getByRole("button", { name: "今すぐ実行" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "再開" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    "/api/bots/one/routines/routine-1",
    { enabled: true },
    "PATCH",
  ));
});
