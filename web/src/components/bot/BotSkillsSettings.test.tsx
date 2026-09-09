// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotSkillsSettings } from "./BotSkillsSettings";

const mocks = vi.hoisted(() => ({ getJson: vi.fn(), onChange: vi.fn() }));
vi.mock("@/lib/client", () => ({ getJson: mocks.getJson }));

const baseSkills = {
  mode: "include" as const,
  include: ["review", "missing-skill"],
  exclude: [],
};

beforeEach(() => {
  mocks.getJson.mockResolvedValue({
    skills: [
      { id: "review", name: "review", description: "レビューを行います。", botEnabled: true, source: "pi" },
      { id: "unsafe", name: "unsafe", description: "危険な操作を確認します。", botEnabled: false, source: "bundled" },
    ],
  });
  mocks.onChange.mockReset();
});

afterEach(() => {
  cleanup();
  mocks.getJson.mockReset();
});

it("shows the selected mode, catalog state, and missing configured names", async () => {
  render(<BotSkillsSettings skills={baseSkills} onChange={mocks.onChange} />);

  expect((screen.getByRole("radio", { name: /選択したものだけ/ }) as HTMLInputElement).checked).toBe(true);
  expect((await screen.findByRole("checkbox", { name: "reviewを使うスキルに指定" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText("Bot全体で無効")).toBeTruthy();
  expect(screen.getByText("missing-skill")).toBeTruthy();
  expect(screen.getByText("2件指定中。選択した項目は一覧の先頭に表示されます。")).toBeTruthy();
});

it("saves catalog selections and mode changes through the existing callback", async () => {
  render(<BotSkillsSettings skills={baseSkills} onChange={mocks.onChange} />);
  await screen.findByRole("checkbox", { name: "reviewを使うスキルに指定" });

  fireEvent.click(screen.getByRole("checkbox", { name: "unsafeを使うスキルに指定" }));
  expect(mocks.onChange).toHaveBeenCalledWith({
    ...baseSkills,
    include: ["review", "missing-skill", "unsafe"],
  });

  fireEvent.click(screen.getByRole("radio", { name: /選択したものを除外/ }));
  expect(mocks.onChange).toHaveBeenLastCalledWith({
    ...baseSkills,
    mode: "exclude",
  });
});

it("deduplicates manually entered names only when applying them", async () => {
  render(<BotSkillsSettings skills={baseSkills} onChange={mocks.onChange} />);
  const textarea = await screen.findByRole("textbox", { name: "使うスキル名" });

  fireEvent.change(textarea, { target: { value: " review \nmanual-skill\nreview\n" } });
  fireEvent.click(screen.getByRole("button", { name: "適用" }));

  expect(mocks.onChange).toHaveBeenCalledWith({
    ...baseSkills,
    include: ["review", "manual-skill"],
  });
});

it("keeps an unsubmitted manual draft when the parent refreshes unrelated data", async () => {
  const view = render(<BotSkillsSettings skills={baseSkills} onChange={mocks.onChange} />);
  const textarea = await screen.findByRole("textbox", { name: "使うスキル名" });
  fireEvent.change(textarea, { target: { value: "draft-skill" } });

  view.rerender(
    <BotSkillsSettings
      skills={{ ...baseSkills, include: [...baseSkills.include] }}
      onChange={mocks.onChange}
    />,
  );

  expect((screen.getByRole("textbox", { name: "使うスキル名" }) as HTMLTextAreaElement).value).toBe("draft-skill");
});

it("allows inheriting the global Bot skill settings without showing a misleading empty allowlist", async () => {
  render(
    <BotSkillsSettings
      skills={{ mode: "inherit", include: ["review"], exclude: ["unsafe"] }}
      onChange={mocks.onChange}
    />,
  );

  await waitFor(() => expect(screen.getByText("設定の「Bot」スキルで有効になっているスキルを使います。")).toBeTruthy());
  expect(screen.queryByRole("checkbox", { name: "reviewを使うスキルに指定" })).toBeNull();
  expect(screen.queryByText("0件指定中")).toBeNull();
});
