// @vitest-environment happy-dom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BotAvatarPicker, type AvatarPatch } from "./BotAvatarPicker";
import { avatarColorForId, BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, MAX_AVATAR_IMAGE_BYTES } from "@/lib/bot-avatar";
import type { BotDto } from "@/lib/types";

const initialBot: BotDto = {
  id: "avatar-test", name: "Bot", label: "Label", soul: "", avatarColor: "#3B82F6", avatarImage: null,
  model: null, thinkingLevel: null, permissionMode: null, skills: { mode: "inherit", include: [], exclude: [] },
  extraRoots: [], enabled: true, notificationsEnabled: true, createdAt: "", updatedAt: "",
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(initial = initialBot, save = vi.fn<(patch: AvatarPatch) => Promise<void>>().mockResolvedValue(undefined)) {
  const onEscape = vi.fn();
  function Preview() {
    const [bot, setBot] = useState(initial);
    return <div onKeyDown={onEscape}><BotAvatarPicker bot={bot} onChange={async (patch) => {
      await save(patch);
      setBot((current) => ({ ...current, ...patch, avatarEyeColor: patch.avatarEyeColor ?? undefined }));
    }} /><button type="button">外側</button></div>;
  }
  render(<Preview />);
  const trigger = screen.getByRole("button", { name: "ボットのアイコンを変更" });
  fireEvent.click(trigger);
  return { trigger, save, onEscape };
}

it("opens from the icon, navigates tabs with the keyboard, and dismisses without closing settings", () => {
  const { trigger, onEscape } = setup();
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Bot" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "生成" }));
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "アップロード" }));
  fireEvent.keyDown(document.activeElement!, { key: "Home" });
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Bot" }));
  onEscape.mockClear();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(onEscape).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole("button", { name: "外側" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  act(() => screen.getByRole("button", { name: "外側" }).focus());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("saves shapes, preset colors and validated custom colors, replacing an uploaded image", async () => {
  const { save } = setup({ ...initialBot, avatarImage: "data:image/png;base64,dGVzdA==" });
  expect(within(screen.getByRole("group", { name: "ボットの形" })).getAllByRole("button")).toHaveLength(8);
  expect(within(screen.getByRole("group", { name: "本体の色" })).getAllByRole("button")).toHaveLength(12);
  fireEvent.click(screen.getByRole("button", { name: "くも" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "くも" }).getAttribute("aria-pressed")).toBe("true"));
  expect(save).toHaveBeenLastCalledWith({ avatarShape: "cloud", avatarImage: null });
  fireEvent.click(screen.getByRole("button", { name: "本体の色 #111111" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "本体の色 #111111" }).getAttribute("aria-pressed")).toBe("true"));
  const code = screen.getByRole("textbox", { name: "本体の色のカラーコード" });
  const apply = within(code.closest("form")!).getByRole("button", { name: "適用" }) as HTMLButtonElement;
  fireEvent.change(code, { target: { value: "#nope" } });
  expect(apply.disabled).toBe(true);
  fireEvent.change(code, { target: { value: "#abcdef" } });
  fireEvent.click(apply);
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ avatarColor: "#ABCDEF", avatarImage: null }));
  await screen.findByText("保存しました");
});

it("saves the eye color, defaults it to white, and toggles glasses and mustache", async () => {
  const { save } = setup();
  const eyes = screen.getByRole("group", { name: "目の色" });
  expect(within(eyes).getAllByRole("button")).toHaveLength(13);
  expect(within(eyes).getByRole("button", { name: "目の色 #FFFFFF" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(eyes).getByRole("button", { name: "目の色 #EF4444" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ avatarEyeColor: "#EF4444", avatarImage: null }));
  await waitFor(() => expect(within(eyes).getByRole("button", { name: "目の色 #EF4444" }).getAttribute("aria-pressed")).toBe("true"));
  for (const [label, key] of [["眼鏡", "avatarGlasses"], ["口ひげ", "avatarMustache"]] as const) {
    expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ [key]: true, avatarImage: null }));
    await waitFor(() => expect(screen.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith({ [key]: false, avatarImage: null }));
  }
});

it("generates local candidates without saving until selected, then resets all avatar fields", async () => {
  const { save } = setup();
  fireEvent.click(screen.getByRole("tab", { name: "生成" }));
  expect(save).not.toHaveBeenCalled();
  expect(within(screen.getByRole("group", { name: "生成したアイコン" })).getAllByRole("button")).toHaveLength(6);
  fireEvent.click(screen.getByRole("button", { name: "別の候補を生成" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "候補 1" }));
  await screen.findByText("保存しました");
  const patch = save.mock.calls[0]![0];
  expect(BOT_AVATAR_SHAPES.map((shape) => shape.id)).toContain(patch.avatarShape);
  expect(BOT_AVATAR_COLORS).toContain(patch.avatarColor);
  expect(patch.avatarImage).toBeNull();
  expect(typeof patch.avatarGlasses).toBe("boolean");
  expect(typeof patch.avatarMustache).toBe("boolean");
  fireEvent.click(screen.getByRole("button", { name: "リセット" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ avatarShape: "circle", avatarColor: avatarColorForId(initialBot.id), avatarEyeColor: null, avatarGlasses: false, avatarMustache: false, avatarImage: null }));
  await screen.findByText("保存しました");
});

it("rejects unsupported or oversized uploads, saves raster data, and removes the image", async () => {
  const { save } = setup();
  fireEvent.click(screen.getByRole("tab", { name: "アップロード" }));
  const input = screen.getByLabelText("ボットの画像を設定");
  for (const file of [new File(["<svg/>"], "bad.svg", { type: "image/svg+xml" }), new File([new Uint8Array(MAX_AVATAR_IMAGE_BYTES + 1)], "big.png", { type: "image/png" })]) {
    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByRole("alert").textContent).toContain("2 MB以下");
  }
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { files: [new File(["test"], "avatar.png", { type: "image/png" })] } });
  await waitFor(() => expect(save).toHaveBeenCalledWith({ avatarImage: "data:image/png;base64,dGVzdA==" }));
  await screen.findByText("保存しました");
  fireEvent.click(screen.getByRole("button", { name: "画像を削除" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ avatarImage: null }));
  await screen.findByText("保存しました");
});

it("keeps the saved avatar on failure, locks concurrent writes, and allows a retry", async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn<(patch: AvatarPatch) => Promise<void>>().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  setup(initialBot, save);
  fireEvent.click(screen.getByRole("button", { name: "三角" }));
  fireEvent.click(screen.getByRole("button", { name: "本体の色 #111111" }));
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toBe("保存中…");
  await act(async () => reject(new Error("保存に失敗しました")));
  expect(screen.getByRole("alert").textContent).toBe("保存に失敗しました");
  expect(screen.getByRole("button", { name: "まる" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "三角" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "三角" }).getAttribute("aria-pressed")).toBe("true"));
  expect(save).toHaveBeenCalledTimes(2);
});

it("surfaces file-read failures and unlocks the picker", async () => {
  const { save } = setup();
  fireEvent.click(screen.getByRole("tab", { name: "アップロード" }));
  vi.stubGlobal("FileReader", class {
    onerror?: () => void;
    readAsDataURL() { this.onerror?.(); }
  });
  fireEvent.change(screen.getByLabelText("ボットの画像を設定"), { target: { files: [new File(["test"], "avatar.png", { type: "image/png" })] } });
  expect((await screen.findByRole("alert")).textContent).toContain("画像を読み込めませんでした");
  expect(save).not.toHaveBeenCalled();
  expect((screen.getByLabelText("ボットの画像を設定") as HTMLInputElement).disabled).toBe(false);
});
