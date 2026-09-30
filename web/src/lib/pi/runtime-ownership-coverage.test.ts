import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The old path must not come back.
 *
 * Removing the in-process runtime (Phase 6) is only safe if every route that can start, stop or answer
 * a session either forwards to the owning Backend or refuses to act locally. This test is the
 * executable definition of that invariant: it scans the WebUI's routes and fails when a session
 * starter appears without an ownership guard.
 *
 * `LOCAL_ONLY_PENDING` is the measured remaining work. Each entry must be wired (or deleted) before the
 * old path can be removed; the test also fails when an entry becomes stale.
 */
const API_DIR = join(__dirname, "..", "..", "app", "api");

/**
 * Harness calls that create, drive, answer, edit or schedule a session in this process. The list is
 * the measured surface: every owner-only operation the WebUI routes can reach, whether directly or
 * through a shared ladder (`handleRoomPrompt`, `revertRoomConversation`).
 */
const SESSION_STARTERS =
  /\b(promptTask|goalLoopCommand|abortTask|abortTaskIncludingColdGoalLoop|stopBotCodeTask|respondToPermissionPrompt|respondToQuestionPrompt|ensureLive|subscribeTask|getTaskBootstrap|getTaskDetail|getTaskDetailBounded|queueBotCodePrompt|runUserBotCodeRequest|revertTask|unrevertTask|compactTask|abortTaskCompaction|setTaskModel|setTaskThinkingLevel|setTaskAgent|runRoutine|handleRoomPrompt|revertRoomConversation|runRoomConversation|runRoomFanOut|runRoomBot|stopRoomTurns|steerRoomTurns|deliverReadyRoomHandoffs)\b/;

/** How a route proves it is not acting as the owner: it consults the switch or forwards. */
const OWNERSHIP_GUARDS =
  /\b(localRuntimeBlocked|forwardTaskPrompt|forwardTaskDetail|forwardTaskAbort|forwardPermissionAnswer|forwardQuestionAnswer)\b/;

/**
 * Routes that still act locally in the non-owning mode, with the measured reason. Every entry is
 * unfinished work, not an allowance: the scan fails when one appears without being listed here.
 */
const LOCAL_ONLY_PENDING: Record<string, string> = {
  "bots/rooms/[id]/route.ts":
    "Room PATCH(resetMessages/members) and DELETE stop turns, Code sessions and member tasks locally; forwarding the room admin actions is the next step",
};

function routeFiles(dir = API_DIR, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, found);
    else if (entry === "route.ts") found.push(full);
  }
  return found;
}

/** Comments name these functions too; only real code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** The routes that touch a session starter, with how they guard themselves. */
function sessionStarters(): Array<{ path: string; guarded: boolean; source: string }> {
  return routeFiles()
    .map((file) => ({ path: relative(API_DIR, file).replace(/\\/g, "/"), source: stripComments(readFileSync(file, "utf8")) }))
    .filter(({ source }) => SESSION_STARTERS.test(source))
    .map(({ path, source }) => ({ path, source, guarded: OWNERSHIP_GUARDS.test(source) }));
}

describe("runtime ownership coverage", () => {
  it("every session starter either guards the ownership or is listed as pending work", () => {
    const unguarded = sessionStarters().filter((route) => !route.guarded);
    const unexpected = unguarded.filter((route) => !(route.path in LOCAL_ONLY_PENDING));
    expect(
      unexpected.map((route) => route.path),
      "a route that starts a session must forward to the Backend or refuse locally",
    ).toEqual([]);
  });

  it("the pending list has no stale entries", () => {
    const starters = sessionStarters();
    const stale = Object.keys(LOCAL_ONLY_PENDING).filter(
      (path) => !starters.some((route) => route.path === path && !route.guarded),
    );
    expect(stale, "a wired or deleted route must leave the pending list").toEqual([]);
  });

  it("the guarded routes are the ones that own sessions today", () => {
    const guarded = sessionStarters()
      .filter((route) => route.guarded)
      .map((route) => route.path)
      .sort();
    expect(guarded).toEqual([
      "bots/[id]/abort/route.ts",
      "bots/[id]/code-requests/route.ts",
      "bots/[id]/code-session/route.ts",
      "bots/[id]/events/route.ts",
      "bots/[id]/prompt/route.ts",
      "bots/[id]/revert/route.ts",
      "bots/[id]/route.ts",
      "bots/[id]/routines/[routineId]/run/route.ts",
      "bots/rooms/[id]/code/route.ts",
      "bots/rooms/[id]/events/route.ts",
      "bots/rooms/[id]/prompt/route.ts",
      "bots/rooms/[id]/revert/route.ts",
      "tasks/[id]/abort/route.ts",
      "tasks/[id]/agent/route.ts",
      "tasks/[id]/compact/abort/route.ts",
      "tasks/[id]/compact/route.ts",
      "tasks/[id]/events/route.ts",
      "tasks/[id]/goal-loop/route.ts",
      "tasks/[id]/messages/route.ts",
      "tasks/[id]/model/route.ts",
      "tasks/[id]/permission/route.ts",
      "tasks/[id]/prompt/route.ts",
      "tasks/[id]/question/route.ts",
      "tasks/[id]/revert/route.ts",
      "tasks/[id]/route.ts",
      "tasks/[id]/thinking/route.ts",
      "tasks/[id]/unrevert/route.ts",
    ]);
  });

  it("counts the remaining work so the removal has a number", () => {
    const starters = sessionStarters();
    const pending = starters.filter((route) => !route.guarded).map((route) => route.path).sort();
    // Every unguarded starter is a measured, listed gap — never an unrecorded one.
    expect(pending).toEqual(Object.keys(LOCAL_ONLY_PENDING).sort());
    expect({ starters: starters.length, guarded: starters.length - pending.length }).toEqual({
      starters: 28,
      guarded: 27,
    });
  });
});
