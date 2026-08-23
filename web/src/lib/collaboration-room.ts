import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { collaborationDataDir, readCollaborationConfig } from "./collaboration";

export type CollaborationLeaseConflict = {
  leaseId: string;
  state: "invalid" | "orphaned";
  ownerSessionId: string;
  ownerName: string;
  ownerOnline: boolean;
  paths: string[];
};

export type CollaborationRoomSummary = {
  ready: boolean;
  peers: number;
  sessionNames: string[];
  leaseConflicts: number;
  pendingAsks: number;
  conflicts?: CollaborationLeaseConflict[];
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
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 1_500,
  });
  return realpathSync.native(output.trim());
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const emptyRoom = (reason: string): CollaborationRoomSummary => ({
  ready: false,
  peers: 0,
  sessionNames: [],
  leaseConflicts: 0,
  pendingAsks: 0,
  conflicts: [],
  reason,
});

function leaseConflictsFrom(
  leases: Record<string, unknown>,
  sessions: Record<string, unknown>,
): CollaborationLeaseConflict[] {
  const conflicts: CollaborationLeaseConflict[] = [];
  for (const [leaseId, raw] of Object.entries(leases)) {
    const lease = record(raw);
    const state = String(lease.state ?? "");
    if (state !== "invalid" && state !== "orphaned") continue;
    const ownerSessionId = typeof lease.ownerSessionId === "string" ? lease.ownerSessionId : "";
    const owner = record(sessions[ownerSessionId]);
    const ownerName = typeof owner.displayName === "string" && owner.displayName.trim()
      ? owner.displayName.trim().slice(0, 120)
      : "不明なセッション";
    const paths = Array.isArray(lease.selectors)
      ? lease.selectors.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 12)
      : [];
    conflicts.push({
      leaseId: typeof lease.id === "string" && lease.id ? lease.id : leaseId,
      state,
      ownerSessionId,
      ownerName,
      ownerOnline: Boolean(ownerSessionId) && Object.keys(owner).length > 0 && owner.state !== "offline",
      paths,
    });
    if (conflicts.length >= 20) break;
  }
  return conflicts;
}

export function readCollaborationRoom(rootPath: string, env: NodeJS.ProcessEnv = process.env): CollaborationRoomSummary {
  try {
    const root = repositoryRoot(rootPath);
    const snapshotPath = join(collaborationDataDir(env), "rooms", projectKey(root), "snapshot.json");
    if (!existsSync(snapshotPath)) {
      return emptyRoom("Room snapshot is not available.");
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as RoomSnapshotLike;
    const sessions = record(snapshot.sessions);
    const leases = record(snapshot.leases);
    const connectedSessions = Object.values(sessions).filter((session) => record(session).state !== "offline");
    const sessionNames = connectedSessions.map((session) => {
      const name = record(session).displayName;
      return typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : "LeafCode session";
    });
    const pendingAsks = Array.isArray(snapshot.pendingAsks)
      ? snapshot.pendingAsks.filter((ask) => Date.parse(String(record(ask).expiresAt ?? "")) > Date.now()).length
      : 0;
    const updatedAt = typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : undefined;
    const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    const heartbeatMs = readCollaborationConfig(env).config.heartbeatMs;
    const stale = !Number.isFinite(updatedMs) || Date.now() - updatedMs > Math.max(15_000, heartbeatMs * 4);
    const conflicts = leaseConflictsFrom(leases, sessions);
    return {
      ready: !stale,
      peers: connectedSessions.length,
      sessionNames,
      leaseConflicts: conflicts.length,
      pendingAsks,
      conflicts,
      ...(typeof snapshot.epoch === "number" ? { epoch: snapshot.epoch } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      ...(stale ? { reason: "Room snapshot is stale." } : {}),
    };
  } catch (error) {
    return emptyRoom(error instanceof Error ? error.message : "Room snapshot could not be read.");
  }
}
