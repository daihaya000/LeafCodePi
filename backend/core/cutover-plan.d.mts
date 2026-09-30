export type CutoverBlockerCode =
  | "backend-not-configured"
  | "backend-unreachable"
  | "backend-not-ready"
  | "runtime-detached"
  | "generation-mismatch"
  | "another-owner"
  | "active-work"
  | "goal-loop-active"
  | "foreign-lease"
  | "mixed-ownership"
  | "relay-disabled";

export type CutoverBlocker = { code: CutoverBlockerCode; detail?: string | number };

export type CutoverPreflightResult = {
  ok: boolean;
  blockers: CutoverBlocker[];
  activeTasks: number;
  goalLoopSessions: number;
  foreignLeases: number;
};

export function cutoverPreflight(input: {
  backendConfigured?: boolean;
  health?: { ok?: boolean; ready?: boolean; runtimeGeneration?: string | null } | null;
  expectedGeneration?: string;
  activeTasks?: ReadonlyArray<{ status?: string }>;
  goalLoopSessions?: number;
  leases?: ReadonlyArray<{ pid?: number | string | null }>;
  ownPid?: number | string | null;
  otherOwner?: boolean;
  relayEnabled?: boolean;
  webOwnsRuntime?: boolean;
}): CutoverPreflightResult;
