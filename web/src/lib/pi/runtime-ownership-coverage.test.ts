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

/** Harness calls that create, drive or answer a session in this process. */
const SESSION_STARTERS =
  /\b(promptTask|goalLoopCommand|abortTask|abortTaskIncludingColdGoalLoop|stopBotCodeTask|respondToPermissionPrompt|respondToQuestionPrompt|ensureLive|subscribeTask|getTaskBootstrap|getTaskDetail|getTaskDetailBounded|queueBotCodePrompt|runUserBotCodeRequest)\b/;

/** How a route proves it is not acting as the owner: it consults the switch or forwards. */
const OWNERSHIP_GUARDS =
  /\b(localRuntimeBlocked|forwardTaskPrompt|forwardTaskDetail|forwardTaskAbort|forwardPermissionAnswer|forwardQuestionAnswer)\b/;

/** Routes that still act locally in the non-owning mode, with the reason they are still allowed. */
const LOCAL_ONLY_PENDING: Record<string, string> = {
  "bots/[id]/code-requests/route.ts": "Bot code request list reads the outbox this process owns",
  "bots/[id]/code-session/route.ts": "starting a Bot Code session is not forwarded yet",
  "bots/[id]/events/route.ts": "Bot event stream is still the in-process subscription",
  "bots/[id]/route.ts": "Bot task detail read is not forwarded yet",
  "bots/rooms/[id]/code/route.ts": "Room Code start is not forwarded yet",
  "bots/rooms/[id]/events/route.ts": "Room event stream is still the in-process subscription",
  "tasks/[id]/goal-loop/route.ts": "Goal Loop start resolves locally and is not forwarded yet",
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
      "bots/[id]/prompt/route.ts",
      "tasks/[id]/abort/route.ts",
      "tasks/[id]/events/route.ts",
      "tasks/[id]/messages/route.ts",
      "tasks/[id]/permission/route.ts",
      "tasks/[id]/prompt/route.ts",
      "tasks/[id]/question/route.ts",
      "tasks/[id]/route.ts",
    ]);
  });

  it("counts the remaining work so the removal has a number", () => {
    const starters = sessionStarters();
    const pending = starters.filter((route) => !route.guarded);
    expect({ starters: starters.length, pending: pending.length }).toEqual({
      starters: starters.length,
      pending: Object.keys(LOCAL_ONLY_PENDING).length,
    });
    expect(pending.length).toBeGreaterThan(0);
  });
});
