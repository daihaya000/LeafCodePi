import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { insertTask, patchTask, upsertProject } from "@/lib/store";
import { readTaskProgressSnapshot } from "./harness";

const GLOBAL_KEY = "__leafcodePiHarness";
const previousHarness = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (previousHarness === undefined) delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  else (globalThis as Record<string, unknown>)[GLOBAL_KEY] = previousHarness;
  if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
  else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type FixtureLive = { taskId: string } & Record<string, unknown>;

function installFixtureHarness(live: Map<string, FixtureLive>, pi?: unknown): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    live,
    events: new EventEmitter(),
    ...(pi === undefined ? {} : { pi }),
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "leafcode-pi-harness-progress-"));
  tempDirs.push(root);
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
  const project = upsertProject({ name: "demo", rootPath: root });
  const task = insertTask({ project, title: "progress" });
  return { root, task };
}

describe("readTaskProgressSnapshot", () => {
  it("projects the live session in memory, including the reply being streamed", async () => {
    const { root, task } = setup();
    const messages = [
      { role: "user", content: "バグを直して", timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "todowrite",
            arguments: { todos: [{ content: "修正", status: "in_progress", priority: "high" }] },
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "todowrite",
        content: [{ type: "text", text: "ok" }],
        details: { todos: [{ id: "1", content: "修正", status: "in_progress", priority: "high" }] },
        isError: false,
        timestamp: 2,
      },
    ];
    const streamingMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "テストを実行します" },
        { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "npm test" } },
      ],
      timestamp: 3,
    };
    // prompt / steer / followUp は用意しない。進捗確認がエージェントへ触れれば TypeError で失敗する。
    const session = {
      sessionId: "session-1",
      isStreaming: true,
      isCompacting: false,
      messages,
      agent: { state: { streamingMessage } },
      sessionManager: { getLeafId: () => null, getBranch: () => [], getCwd: () => root },
    };
    const live = new Map<string, FixtureLive>([[task.id, {
      taskId: task.id,
      accountId: null,
      accountByMessageId: new Map(),
      agentName: null,
      agentByMessageId: new Map(),
      session,
      throughputByStartedAt: new Map(),
      toolStartedAt: new Map(),
      toolEndedAt: new Map(),
      toolPartialOutputByCallId: new Map([["call-2", "PASS 3 tests"]]),
    }]]);
    installFixtureHarness(live);
    const before = JSON.stringify(messages);

    const snapshot = await readTaskProgressSnapshot(task.id);

    assert.equal(snapshot.task.id, task.id);
    assert.equal(snapshot.isStreaming, true);
    assert.equal(snapshot.isCompacting, false);
    assert.deepEqual(snapshot.todos.map((todo) => [todo.content, todo.status]), [["修正", "in_progress"]]);
    const last = snapshot.messages.at(-1);
    assert.equal(last?.role, "assistant");
    const textPart = last?.parts.find((part) => part.type === "text");
    assert.equal(textPart && "text" in textPart ? textPart.text : undefined, "テストを実行します");
    const toolPart = last?.parts.find((part) => part.type === "tool");
    assert.equal(toolPart?.type === "tool" ? toolPart.state.status : undefined, "running");
    assert.equal(toolPart?.type === "tool" ? toolPart.state.output : undefined, "PASS 3 tests");
    assert.equal(snapshot.pendingPermission, null);
    assert.equal(snapshot.pendingQuestion, null);
    // 読み取りだけで、会話もライブランタイムも変えない。
    assert.equal(JSON.stringify(messages), before);
    assert.equal(live.size, 1);
  });

  it("reads the saved transcript without creating a live session", async () => {
    const { root, task } = setup();
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, "{}\n", "utf8");
    patchTask(task.id, { sessionFile });
    const live = new Map<string, FixtureLive>();
    let opened = 0;
    installFixtureHarness(live, {
      SessionManager: {
        open: (file: string) => {
          opened += 1;
          assert.equal(file, sessionFile);
          return {
            buildSessionContext: () => ({
              messages: [
                { role: "user", content: "保存された依頼", timestamp: 1 },
                { role: "assistant", content: [{ type: "text", text: "対応済み" }], timestamp: 2 },
              ],
            }),
          };
        },
      },
    });

    const snapshot = await readTaskProgressSnapshot(task.id);

    assert.equal(opened, 1);
    assert.equal(live.has(task.id), false);
    assert.equal(snapshot.isStreaming, false);
    assert.equal(snapshot.goalLoop, null);
    assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant"]);
  });

  it("rejects an unknown task with 404", async () => {
    setup();
    installFixtureHarness(new Map());

    await assert.rejects(
      readTaskProgressSnapshot("missing-task"),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
  });
});
