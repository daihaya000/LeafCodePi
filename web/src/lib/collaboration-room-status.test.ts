import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { readCollaborationRoom } from "./collaboration-room";

describe("readCollaborationRoom", () => {
  let repo = "";
  let dataDir = "";

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    repo = "";
    dataDir = "";
  });

  it("reads bounded room metadata without exposing message bodies", () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-room-status-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-room-status-data-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore", windowsHide: true });
    const root = realpathSync.native(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim());
    const key = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
    const snapshotPath = join(dataDir, "rooms", key, "snapshot.json");
    mkdirSync(join(dataDir, "rooms", key), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({
      schema: 1,
      projectKey: key,
      epoch: 4,
      updatedAt: new Date().toISOString(),
      sessions: { a: { state: "active" }, b: { state: "away" }, c: { state: "offline" } },
      leases: { clean: { state: "dirty" }, conflict: { state: "orphaned" } },
      pendingAsks: [{ requestId: "ask-1", expiresAt: new Date(Date.now() + 60_000).toISOString() }],
      activity: [{ kind: "ask", paths: [] }],
    }), "utf8");

    assert.deepEqual(readCollaborationRoom(repo, { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir }), {
      ready: true,
      peers: 2,
      leaseConflicts: 1,
      pendingAsks: 1,
      epoch: 4,
      updatedAt: JSON.parse(readFileSync(snapshotPath, "utf8")).updatedAt,
    });
  });

  it("reports a missing room as degraded", () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-room-status-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "leafcode-room-status-data-"));
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore", windowsHide: true });
    const room = readCollaborationRoom(repo, { ...process.env, LEAFCODE_PI_DATA_DIR: dataDir });
    assert.equal(room.ready, false);
    assert.equal(room.peers, 0);
    assert.equal(room.pendingAsks, 0);
  });

  it("does not leak git stderr for a non-repository", () => {
    repo = mkdtempSync(join(tmpdir(), "leafcode-room-status-nonrepo-"));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const room = readCollaborationRoom(repo);
      assert.equal(room.ready, false);
      assert.equal(stderrWrite.mock.calls.length, 0);
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
