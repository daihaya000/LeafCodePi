import type { GraphCommit } from "@/lib/types";

export type GraphEdge = {
  fromLane: number;
  toLane: number;
  color: number;
  /** upper = into this commit from above; lower = leaving toward parents below */
  half: "upper" | "lower";
};

export type GraphRow = {
  commit: GraphCommit;
  lane: number;
  color: number;
  laneCount: number;
  /** active vertical rails through this row (excluding the commit lane itself) */
  passes: { lane: number; color: number }[];
  edges: GraphEdge[];
};

export const LANE_COLORS = 6;

/**
 * Swimlane layout for commits newest-first.
 * - First parent continues on the same lane
 * - Extra parents open new lanes (drawn in the lower half of the merge row)
 * - When several lanes meet the same commit, extra lanes curve in (upper half)
 */
export function layoutGraph(commits: GraphCommit[]): GraphRow[] {
  const rows: GraphRow[] = [];
  // lanes[i] = hash expected next on this lane (going older / downward)
  let lanes: (string | null)[] = [];
  const colorOf = new Map<number, number>();
  let nextColor = 0;

  const colorFor = (lane: number) => {
    if (!colorOf.has(lane)) {
      colorOf.set(lane, nextColor % LANE_COLORS);
      nextColor += 1;
    }
    return colorOf.get(lane)!;
  };

  for (const commit of commits) {
    const waiting = lanes
      .map((h, i) => (h === commit.hash ? i : -1))
      .filter((i) => i >= 0);

    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0];
    } else {
      lane = lanes.findIndex((h) => h === null);
      if (lane < 0) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    colorFor(lane);

    const edges: GraphEdge[] = [];
    const passes: { lane: number; color: number }[] = [];

    for (let i = 0; i < lanes.length; i++) {
      if (i === lane) continue;
      if (lanes[i] && lanes[i] !== commit.hash) {
        passes.push({ lane: i, color: colorFor(i) });
      }
    }

    // Other lanes that were waiting for this same commit → converge (upper)
    for (const other of waiting.slice(1)) {
      edges.push({
        fromLane: other,
        toLane: lane,
        color: colorFor(other),
        half: "upper",
      });
    }

    // Clear all lanes that pointed at this commit
    const next: (string | null)[] = lanes.map((h) =>
      h === commit.hash ? null : h,
    );
    while (next.length <= lane) next.push(null);

    const firstParent = commit.parents[0] ?? null;
    next[lane] = firstParent;

    // Additional parents → new/reuse lanes, fork downward from this commit
    for (let pi = 1; pi < commit.parents.length; pi++) {
      const parent = commit.parents[pi];
      let pl = next.findIndex((h) => h === parent);
      if (pl < 0) {
        pl = next.findIndex((h, idx) => h === null && idx !== lane);
        if (pl < 0) {
          pl = next.length;
          next.push(parent);
        } else {
          next[pl] = parent;
        }
      }
      colorFor(pl);
      edges.push({
        fromLane: lane,
        toLane: pl,
        color: colorFor(pl),
        half: "lower",
      });
    }

    while (next.length > 0 && next[next.length - 1] === null) next.pop();

    rows.push({
      commit,
      lane,
      color: colorFor(lane),
      laneCount: Math.max(lanes.length, next.length, lane + 1, 1),
      passes,
      edges,
    });

    lanes = next;
  }

  return rows;
}

/** Prefer current branch, then non-worktree names; cap visible badges. */
export function pickBranchBadges(
  names: string[],
  currentBranch: string | null,
  max = 2,
): { shown: string[]; more: number } {
  if (names.length === 0) return { shown: [], more: 0 };
  const uniq = [...new Set(names)];
  const score = (n: string) => {
    if (currentBranch && n === currentBranch) return 0;
    if (n === "main" || n === "master") return 1;
    if (n.startsWith("webui/")) return 3;
    return 2;
  };
  uniq.sort((a, b) => score(a) - score(b) || a.localeCompare(b));

  // If current + others all share the tip, still show current first
  const shown = uniq.slice(0, max);
  return { shown, more: Math.max(0, uniq.length - shown.length) };
}
