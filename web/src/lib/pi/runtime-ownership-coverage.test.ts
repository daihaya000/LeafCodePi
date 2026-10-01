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
  /\b(promptTask|goalLoopCommand|abortTask|abortTaskIncludingColdGoalLoop|stopBotCodeTask|respondToPermissionPrompt|respondToQuestionPrompt|ensureLive|subscribeTask|getTaskBootstrap|getTaskDetail|getTaskDetailBounded|queueBotCodePrompt|runUserBotCodeRequest|revertTask|unrevertTask|compactTask|abortTaskCompaction|setTaskModel|setTaskThinkingLevel|setTaskAgent|runRoutine|handleRoomPrompt|handleRoomPatch|handleRoomDelete|revertRoomConversation|runRoomConversation|runRoomFanOut|runRoomBot|stopRoomTurns|steerRoomTurns|deliverReadyRoomHandoffs)\b/;

/** How a route proves it is not acting as the owner: it consults the switch or forwards. */
const OWNERSHIP_GUARDS =
  /\b(localRuntimeBlocked|forwardTaskPrompt|forwardTaskDetail|forwardTaskAbort|forwardPermissionAnswer|forwardQuestionAnswer)\b/;

/**
 * Routes that still act locally in the non-owning mode, with the measured reason. Every entry is
 * unfinished work, not an allowance: the scan fails when one appears without being listed here.
 */
const LOCAL_ONLY_PENDING: Record<string, string> = {
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
      "bots/rooms/[id]/route.ts",
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
      guarded: 28,
    });
    // No route may act as a second owner: every starter is guarded and the pending list is empty.
    expect(pending).toEqual([]);
  });
});

/**
 * The route-level scan above cannot see a method that skips the guard its sibling has (`tasks/[id]`
 * forwards GET but DELETE still archives locally). This scan works per exported handler, over the
 * wider set of operations that tear down, stop or reload sessions the Backend owns.
 *
 * `createTask` is deliberately absent until its forwarding lands; it is tracked separately.
 */
const OWNER_OPERATIONS =
  /\b(destroyArchivedTasksByProject|archiveTask|destroyTask|archiveProjectAndStopTasks|destroyProject|migrateProject|promoteTask|handoffTaskToBot|releaseTaskFromBot|reloadLiveSessionsContext|refreshLiveSessionsForAgentDefinition|resetTaskConversation|setBotModel|setBotPermissionMode|setBotThinkingLevel|setBotTools|requestBotSoulReload|createBotCodeTask|continueBotCodeTask|completeBotCodeRequest|promptTask|goalLoopCommand|abortTask|abortTaskIncludingColdGoalLoop|stopBotCodeTask|respondToPermissionPrompt|respondToQuestionPrompt|revertTask|unrevertTask|compactTask|abortTaskCompaction|setTaskModel|setTaskThinkingLevel|setTaskAgent|runRoutine|handleRoomPrompt|handleRoomPatch|handleRoomDelete|revertRoomConversation)\b/;

const HANDLER_GUARDS = /\b(localRuntimeBlocked|forward[A-Z]\w*|\w+OnBackend|relayFallbackAllowed|readBackend\w+)\b/;

const SETTINGS_RELOAD = "the Backend's live sessions are not reloaded; running sessions keep the old context";
const TEARDOWN = "stops/disposes only this process's sessions; the Backend's running session keeps going";

/** Measured handler-level gaps. Each entry is unfinished work; the scan fails on an unlisted one. */
const HANDLER_GAPS: Record<string, string> = {
  "agents-md/route.ts PATCH": SETTINGS_RELOAD,
  "bots-md/route.ts PATCH": SETTINGS_RELOAD,
  "soul-md/route.ts PATCH": SETTINGS_RELOAD,
  "user-md/route.ts PATCH": SETTINGS_RELOAD,
  "extensions/[name]/route.ts PATCH": SETTINGS_RELOAD,
  "mcp/route.ts POST": SETTINGS_RELOAD,
  "mcp/[name]/route.ts PATCH": SETTINGS_RELOAD,
  "mcp/[name]/auth/route.ts POST": SETTINGS_RELOAD,
  "mcp/[name]/auth/route.ts DELETE": SETTINGS_RELOAD,
  "prompts/transfer/route.ts POST": SETTINGS_RELOAD,
  "skills/route.ts POST": SETTINGS_RELOAD,
  "skills/[name]/route.ts PATCH": SETTINGS_RELOAD,
  "bots/[id]/route.ts GET": "setBotTools applies to this process's sessions only",
  "bots/[id]/route.ts DELETE": TEARDOWN,
  "projects/route.ts PATCH": TEARDOWN,
  "projects/route.ts DELETE": TEARDOWN,
  "tasks/route.ts DELETE": "bulk destroy of archived tasks; archived tasks have no live session",
  "tasks/[id]/promote/route.ts POST": "promotion rewires a session this process does not own",
  "tasks/[id]/supervisor/route.ts POST": "hand-off/release rewires a session this process does not own",
};

/** Every exported HTTP handler that touches an owner-only operation, and whether it guards itself. */
function ownerHandlers(): Array<{ id: string; guarded: boolean }> {
  const found: Array<{ id: string; guarded: boolean }> = [];
  for (const file of routeFiles()) {
    const path = relative(API_DIR, file).replaceAll("\\", "/");
    const source = stripComments(readFileSync(file, "utf8"));
    const starts = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
    starts.forEach((match, index) => {
      const body = source.slice(match.index, starts[index + 1]?.index ?? source.length);
      if (!OWNER_OPERATIONS.test(body)) return;
      found.push({ id: `${path} ${match[1]}`, guarded: HANDLER_GUARDS.test(body) });
    });
  }
  return found;
}

describe("runtime ownership coverage per handler", () => {
  it("every handler that touches an owner-only operation guards itself or is a listed gap", () => {
    const unexpected = ownerHandlers().filter((handler) => !handler.guarded && !(handler.id in HANDLER_GAPS));
    expect(unexpected.map((handler) => handler.id), "forward to the Backend or refuse locally").toEqual([]);
  });

  it("the handler gap list has no stale entries", () => {
    const handlers = ownerHandlers();
    const stale = Object.keys(HANDLER_GAPS).filter(
      (id) => !handlers.some((handler) => handler.id === id && !handler.guarded),
    );
    expect(stale, "a wired or deleted handler must leave the gap list").toEqual([]);
  });
});
