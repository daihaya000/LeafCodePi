// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationBadge, CollaborationNotice } from "./CollaborationStatus";

describe("CollaborationStatus", () => {
  afterEach(() => cleanup());

  it("exposes peer count, lease conflicts, and pending asks accessibly", () => {
    const room = { ready: true, peers: 2, leaseConflicts: 1, pendingAsks: 3 };
    render(
      <>
        <CollaborationBadge room={room} />
        <CollaborationNotice room={room} />
      </>,
    );
    expect(screen.getByLabelText("2セッション接続中、競合1件、未処理ask3件")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("lease競合 1件 / 未処理ask 3件");
  });

  it("shows a degraded state without pretending the room is ready", () => {
    render(<CollaborationNotice room={{ ready: false, peers: 0, leaseConflicts: 0, pendingAsks: 0, reason: "stale" }} />);
    expect(screen.getByRole("status").textContent).toContain("協調roomを確認できません: stale");
  });
});
