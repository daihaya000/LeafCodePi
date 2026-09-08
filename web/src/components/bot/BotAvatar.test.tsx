// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BotAvatar } from "./BotAvatar";
import { avatarEyeColor, BOT_AVATAR_SHAPES, isAvatarShape } from "@/lib/bot-avatar";

afterEach(cleanup);

it("renders all shape variants, keeps eyes readable and prioritizes uploaded images", () => {
  const { container, rerender } = render(<BotAvatar />);
  expect(container.querySelector("path")?.getAttribute("d")).toBe(BOT_AVATAR_SHAPES[0].path);
  expect(new Set(BOT_AVATAR_SHAPES.map((shape) => shape.path)).size).toBe(8);
  for (const shape of BOT_AVATAR_SHAPES) {
    expect(isAvatarShape(shape.id)).toBe(true);
    rerender(<BotAvatar shape={shape.id} color="#FFFFFF" active />);
    expect(container.querySelector("path")?.getAttribute("d")).toBe(shape.path);
    expect(container.querySelector("g")?.getAttribute("fill")).toBe("#1D1D1F");
    expect(container.querySelector(".bot-avatar-eyes")).toBeTruthy();
  }
  expect(avatarEyeColor("#000000")).toBe("#FFFFFF");
  expect(avatarEyeColor("invalid")).toBe("#FFFFFF");
  expect(isAvatarShape("__proto__")).toBe(false);
  rerender(<BotAvatar shape="cloud" image="data:image/png;base64,test" />);
  expect(container.querySelector("img")).toBeTruthy();
  expect(container.querySelector("svg")).toBeNull();
});

it("animates only active avatars and stops on completion", () => {
  const { container, rerender } = render(<BotAvatar active />);
  expect(container.querySelector("svg.bot-avatar-working")).toBeTruthy();
  expect(container.querySelector("g.bot-avatar-eyes")).toBeTruthy();
  rerender(<BotAvatar />);
  expect(container.querySelector(".bot-avatar-working, .bot-avatar-eyes")).toBeNull();
  rerender(<BotAvatar active image="data:image/png;base64,test" />);
  expect(container.querySelector("img.bot-avatar-working")).toBeTruthy();
  rerender(<BotAvatar image="data:image/png;base64,test" />);
  expect(container.querySelector(".bot-avatar-working")).toBeNull();
});
