import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { collaborationDataDir, readCollaborationConfig } from "./collaboration";

export type CollaborationRoomSummary = {
  ready: boolean;
  peers: number;
  leaseConflicts: number;
  pendingAsks: number;
  epoch?: number;
  updatedAt?: string;
  reason?: string;
};

type RoomSnapshotLike = {
  epoch?: unknown;
  updatedAt?: unknown;
  sessions?: unknown;
  leases?: unknown;
  pendingAsks?: unknown;
};

function projectKey(root: string): string {
  return createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex");
}

function repositoryRoot(rootPath: string): string {
  const root = realpathSync.native(rootPath);
  const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 1_500,
  });
  return realpathSync.native(output.trim());
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readCollaborationRoom(rootPath: string, env: NodeJS.ProcessEnv = process.env): CollaborationRoomSummary {
  try {
    const root = repositoryRoot(rootPath);
    const snapshotPath = join(collaborationDataDir(env), "rooms", projectKey(root), "snapshot.json");
    if (!existsSync(snapshotPath)) {
      return { ready: false, peers: 0, leaseConflicts: 0, pendingAsks: 0, reason: "Room snapshot is not available." };
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as RoomSnapshotLike;
    const sessions = record(snapshot.sessions);
    const leases = record(snapshot.leases);
    const pendingAsks = Array.isArray(snapshot.pendingAsks)
      ? snapshot.pendingAsks.filter((ask) => Date.parse(String(record(ask).expiresAt ?? "")) > Date.now()).length
      : 0;
    const updatedAt = typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : undefined;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    const heartbeatMs = readCollaborationConfig(env).config.heartbeatMs;
    const stale = !Number.isFinite(updatedMs) || Date.now() - updatedMs > Math.max(15_000, heartbeatMs * 4);
    return {
      ready: !stale,
      peers: Object.values(sessions).filter((session) => record(session).state !== "offline").length,
      leaseConflicts: Object.values(leases).filter((lease) => ["invalid", "orphaned"].includes(String(record(lease).state))).length,
      pendingAsks,
      ...(typeof snapshot.epoch === "number" ? { epoch: snapshot.epoch } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(stale ? { reason: "Room snapshot is stale." } : {}),
    };
  } catch (error) {
    return {
      ready: false,
      peers: 0,
      leaseConflicts: 0,
      pendingAsks: 0,
      reason: error instanceof Error ? error.message : "Room snapshot could not be read.",
    };
  }
}
