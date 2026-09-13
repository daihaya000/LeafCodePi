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

it("creates a daily routine without exposing cron input", async () => {
  render(<BotRoutineSettings botId="one" routines={[]} onRefresh={vi.fn()} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "作成" }));
  expect(screen.queryByRole("textbox", { name: "cron スケジュール" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("毎日 09:00 に実行");
  fireEvent.change(screen.getByRole("textbox", { name: "ルーティン名" }), { target: { value: "朝" } });
  fireEvent.change(screen.getByRole("textbox", { name: "ルーティンの指示" }), { target: { value: "確認" } });
  fireEvent.change(screen.getByLabelText("実行時刻"), { target: { value: "08:30" } });
  fireEvent.click(screen.getByRole("button", { name: "作成" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    "/api/bots/one/routines", { name: "朝", prompt: "確認", schedule: "30 8 * * *" }, "POST",
  ));
});

it("selects weekdays and prevents saving an empty day or time selection", async () => {
  render(<BotRoutineSettings botId="one" routines={[routine]} onRefresh={vi.fn()} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "編集" }));
  fireEvent.change(screen.getByRole("combobox", { name: "繰り返し" }), { target: { value: "weekly" } });
  for (const day of ["月", "火", "水", "木", "金"]) fireEvent.click(screen.getByRole("checkbox", { name: `${day}曜日` }));
  expect(screen.getByRole("alert").textContent).toContain("曜日を1つ以上");
  expect((screen.getByRole("button", { name: "変更を保存" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "日曜日" }));
  fireEvent.change(screen.getByLabelText("実行時刻"), { target: { value: "" } });
  expect((screen.getByRole("button", { name: "変更を保存" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("実行時刻"), { target: { value: "18:45" } });
  fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    "/api/bots/one/routines/routine-1", { name: "朝の確認", prompt: "Check status", schedule: "45 18 * * 0" }, "PATCH",
  ));
});

it("warns about missing month days and offers only evenly spaced safe intervals", () => {
  render(<BotRoutineSettings botId="one" routines={[routine]} onRefresh={vi.fn()} onError={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "編集" }));
  fireEvent.change(screen.getByRole("combobox", { name: "繰り返し" }), { target: { value: "monthly" } });
  fireEvent.change(screen.getByRole("combobox", { name: "日付" }), { target: { value: "31" } });
  expect(screen.getByText("31日がない月は実行されません。")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "繰り返し" }), { target: { value: "interval" } });
  const intervals = screen.getByRole("combobox", { name: "実行間隔" }) as HTMLSelectElement;
  expect([...intervals.options].map((option) => option.value)).toEqual(["5", "10", "15", "20", "30"]);
  fireEvent.change(intervals, { target: { value: "10" } });
  expect(screen.getByRole("status").textContent).toBe("10分ごと に実行");
});

it("preserves a custom cron and resets the picker when switching routines", async () => {
  const custom = { ...routine, id: "custom", schedule: "15 8,17 * 1-6 1-5" };
  render(<BotRoutineSettings botId="one" routines={[custom, routine]} onRefresh={vi.fn()} onError={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "編集" })[0]);
  expect((screen.getByRole("textbox", { name: "cron スケジュール" }) as HTMLInputElement).value).toBe(custom.schedule);
  fireEvent.click(screen.getByRole("button", { name: "変更を保存" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    "/api/bots/one/routines/custom", { name: custom.name, prompt: custom.prompt, schedule: custom.schedule }, "PATCH",
  ));
  await waitFor(() => expect(screen.queryByRole("button", { name: "変更を保存" })).toBeNull());
  fireEvent.click(screen.getAllByRole("button", { name: "編集" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "編集" })[1]);
  expect((screen.getByRole("combobox", { name: "繰り返し" }) as HTMLSelectElement).value).toBe("hourly");
  expect(screen.queryByRole("textbox", { name: "cron スケジュール" })).toBeNull();
});

it("pauses a routine and keeps test execution available only while enabled", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<BotRoutineSettings botId="one" routines={[{ ...routine, enabled: false }]} onRefresh={refresh} onError={vi.fn()} />);

  expect((screen.getByRole("button", { name: "今すぐ実行" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "有効化" }));
  await waitFor(() => expect(mocks.sendJson).toHaveBeenCalledWith(
    "/api/bots/one/routines/routine-1",
    { enabled: true },
    "PATCH",
  ));
});
