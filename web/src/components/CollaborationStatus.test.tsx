// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationBadge, CollaborationNotice } from "./CollaborationStatus";

describe("CollaborationStatus", () => {
  afterEach(() => cleanup());

  it("exposes peer count, lease conflicts, and pending asks accessibly", () => {
    const room = { ready: true, peers: 2, sessionNames: ["Alpha", "Beta"], leaseConflicts: 1, pendingAsks: 3 };
    render(
      <>
        <CollaborationBadge room={room} />
        <CollaborationNotice room={room} />
      </>,
    );
    const badge = screen.getByLabelText("2セッション接続中、競合1件、未処理ask3件、接続中のセッション: Alpha、Beta");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("title")).toContain("Alpha、Beta");
    expect(screen.getByRole("status").textContent).toContain("lease競合 1件 / 未処理ask 3件");
    expect(screen.getByRole("status").textContent).toContain("切れたセッションや外部変更で無効になったファイル予約");
  });

  it("explains a lease conflict and offers discard when a project is selected", () => {
    const room = {
      ready: true,
      peers: 1,
      sessionNames: ["Alpha"],
      leaseConflicts: 1,
      pendingAsks: 0,
      conflicts: [{
        leaseId: "lease-1",
        state: "orphaned" as const,
        ownerSessionId: "s1",
        ownerName: "Alpha",
        ownerOnline: false,
        paths: ["src/a.ts"],
      }],
    };
    render(<CollaborationNotice projectId="proj" room={room} />);
    expect(screen.getByText("切断後に残った予約")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "予約を解除" })).toBeTruthy();
  });

  it("shows a degraded state without pretending the room is ready", () => {
    render(<CollaborationNotice room={{ ready: false, peers: 0, sessionNames: [], leaseConflicts: 0, pendingAsks: 0, reason: "stale" }} />);
    expect(screen.getByRole("status").textContent).toContain("協調roomを確認できません: stale");
  });
});
