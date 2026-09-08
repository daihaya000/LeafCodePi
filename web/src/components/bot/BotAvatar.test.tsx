// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BotAvatar } from "./BotAvatar";
import { autoEyeColor, BOT_AVATAR_SHAPES, isAvatarShape } from "@/lib/bot-avatar";

afterEach(cleanup);

it("renders all shape variants, keeps eyes readable and prioritizes uploaded images", () => {
  const { container, rerender } = render(<BotAvatar />);
  expect(container.querySelector("path")?.getAttribute("d")).toBe(BOT_AVATAR_SHAPES[0].path);
  expect(new Set(BOT_AVATAR_SHAPES.map((shape) => shape.path)).size).toBe(8);
  for (const shape of BOT_AVATAR_SHAPES) {
    expect(isAvatarShape(shape.id)).toBe(true);
    rerender(<BotAvatar avatarShape={shape.id} avatarColor="#FFFFFF" active />);
    expect(container.querySelector("path")?.getAttribute("d")).toBe(shape.path);
    expect(container.querySelector("g")?.getAttribute("fill")).toBe("#000000");
    expect(container.querySelector(".bot-avatar-eyes")).toBeTruthy();
  }
  // White is the default ink; only pale bodies flip to dark eyes.
  expect(["#000000", "#3B82F6", "#10B981", "invalid"].map(autoEyeColor)).toEqual(Array(4).fill("#FFFFFF"));
  expect(["#FFFFFF", "#F5F5F5", "#EAB308"].map(autoEyeColor)).toEqual(Array(3).fill("#000000"));
  expect(isAvatarShape("__proto__")).toBe(false);
  rerender(<BotAvatar avatarShape="cloud" avatarImage="data:image/png;base64,test" />);
  expect(container.querySelector("img")).toBeTruthy();
  expect(container.querySelector("svg")).toBeNull();
});

it("draws optional glasses and mustache in the chosen eye color", () => {
  const { container, rerender } = render(<BotAvatar avatarColor="#111111" />);
  expect(container.querySelector("[data-part='glasses'], [data-part='mustache']")).toBeNull();
  rerender(<BotAvatar avatarColor="#111111" avatarGlasses avatarMustache avatarEyeColor="#000000" />);
  expect(container.querySelector("g[fill='#000000']")).toBeTruthy();
  expect(container.querySelector("[data-part='glasses']")?.getAttribute("stroke")).toBe("#000000");
  expect(container.querySelectorAll("[data-part='glasses'] circle")).toHaveLength(2);
  expect(container.querySelector("rect")?.getAttribute("height")).toBe("16");
  expect(container.querySelector("[data-part='mustache']")).toBeTruthy();
  // An invalid stored color falls back to the automatic ink instead of breaking the face.
  rerender(<BotAvatar avatarColor="#111111" avatarGlasses avatarEyeColor="#EF4444" />);
  expect(container.querySelector("[data-part='glasses']")?.getAttribute("stroke")).toBe("#FFFFFF");
  rerender(<BotAvatar avatarColor="#111111" avatarGlasses avatarMustache avatarImage="data:image/png;base64,test" />);
  expect(container.querySelector("[data-part='glasses'], [data-part='mustache']")).toBeNull();
});

it("animates only active avatars and stops on completion", () => {
  const { container, rerender } = render(<BotAvatar active />);
  expect(container.querySelector("svg.bot-avatar-working")).toBeTruthy();
  expect(container.querySelector("g.bot-avatar-eyes")).toBeTruthy();
  rerender(<BotAvatar />);
  expect(container.querySelector(".bot-avatar-working, .bot-avatar-eyes")).toBeNull();
  rerender(<BotAvatar active avatarImage="data:image/png;base64,test" />);
  expect(container.querySelector("img.bot-avatar-working")).toBeTruthy();
  rerender(<BotAvatar avatarImage="data:image/png;base64,test" />);
  expect(container.querySelector(".bot-avatar-working")).toBeNull();
});
