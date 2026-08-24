// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  afterEach(() => cleanup());

  it("labels an idle worktree as clean", () => {
    render(<StatusBadge status="idle" />);
    expect(screen.getByText("クリーン")).toBeTruthy();
  });

  it("labels a changed worktree as changed", () => {
    render(<StatusBadge status="ready" />);
    expect(screen.getByText("変更あり")).toBeTruthy();
  });
});
