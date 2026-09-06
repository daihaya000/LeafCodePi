// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { BotAvatar } from "./BotAvatar";

afterEach(cleanup);

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
