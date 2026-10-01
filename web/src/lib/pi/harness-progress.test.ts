import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { insertTask, patchTask, upsertProject } from "@/lib/store";
import { getTaskDetail, getTaskDetailReadOnly, readTaskProgressSnapshot } from "./harness";

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
      lastActivityAt: 123,
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
    const detail = await getTaskDetail(task.id, { readOnly: true });
    assert.match(JSON.stringify(detail.messages), /テストを実行します/);
    assert.equal(detail.isStreaming, true);
    assert.equal(live.get(task.id)?.lastActivityAt, 123, "a read must not keep an idle session alive");
    const summary = await getTaskDetail(task.id, { readOnly: true, includeMessages: false });
    assert.deepEqual(summary.messages, []);
    assert.equal(summary.activity, "コマンド");
    const offline = await getTaskDetail(task.id, { readOnly: true, offline: true });
    assert.deepEqual(offline.messages, [], "explicit offline still excludes memory-only replies");
    patchTask(task.id, { status: "archived" });
    const archived = await getTaskDetailReadOnly(task.id);
    assert.deepEqual(archived.messages, [], "archived detail must ignore a leftover live entry");
    assert.equal(archived.isStreaming, false);
    assert.equal(live.get(task.id)?.lastActivityAt, 123);
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
    const second = await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 1, "unchanged transcript must not be reopened or reprojected");
    assert.deepEqual(second.messages, snapshot.messages);
    const coldDetail = await getTaskDetailReadOnly(task.id);
    assert.deepEqual(coldDetail.messages, snapshot.messages);
    assert.equal(opened, 1, "cold read-only detail reuses the transcript, without creating a session");
    assert.equal(live.size, 0);
    writeFileSync(sessionFile, "{}\n{}\n", "utf8");
    await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 2, "append must invalidate the snapshot");
    rmSync(sessionFile);
    assert.deepEqual((await readTaskProgressSnapshot(task.id)).messages, []);
    writeFileSync(sessionFile, "{}\n", "utf8");
    await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 3, "recreated transcript must not reuse the old snapshot");
  });

  it("invalidates a same-size rewrite even when mtime is restored", async () => {
    const { root, task } = setup();
    const sessionFile = join(root, "rewritten.jsonl");
    const mtime = new Date("2020-01-01T00:00:00Z");
    writeFileSync(sessionFile, "old\n", "utf8");
    utimesSync(sessionFile, mtime, mtime);
    patchTask(task.id, { sessionFile });
    let opened = 0;
    installFixtureHarness(new Map(), {
      SessionManager: {
        open: () => {
          opened += 1;
          return { buildSessionContext: () => ({ messages: [{ role: "user", content: `revision-${opened}`, timestamp: 1 }] }) };
        },
      },
    });
    await readTaskProgressSnapshot(task.id);
    writeFileSync(sessionFile, "new\n", "utf8");
    utimesSync(sessionFile, mtime, mtime);
    const next = await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 2);
    assert.match(JSON.stringify(next.messages), /revision-2/);
  });

  it("rejects an unknown task with 404", async () => {
    setup();
    installFixtureHarness(new Map());

    await assert.rejects(
      readTaskProgressSnapshot("missing-task"),
      (error: unknown) => (error as { status?: number }).status === 404,
    );
    await assert.rejects(getTaskDetailReadOnly("missing-task"), (error: unknown) => (error as { status?: number }).status === 404);
  });

  it("does not cache a transcript that changes during projection", async () => {
    const { root, task } = setup();
    const sessionFile = join(root, "changing.jsonl");
    writeFileSync(sessionFile, "{}\n", "utf8");
    patchTask(task.id, { sessionFile });
    let opened = 0;
    installFixtureHarness(new Map(), {
      SessionManager: { open: () => {
        opened += 1;
        if (opened === 1) writeFileSync(sessionFile, "{}\n{}\n", "utf8");
        return { buildSessionContext: () => ({ messages: [] }) };
      } },
    });
    await readTaskProgressSnapshot(task.id);
    await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 2);
    await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 2);
  });

  it("bounds retained transcripts and skips caching large files", async () => {
    const { root, task } = setup();
    let opened = 0;
    installFixtureHarness(new Map(), {
      SessionManager: { open: () => {
        opened += 1;
        return { buildSessionContext: () => ({ messages: [] }) };
      } },
    });
    for (let index = 0; index < 9; index++) {
      const sessionFile = join(root, `session-${index}.jsonl`);
      writeFileSync(sessionFile, "{}\n", "utf8");
      patchTask(task.id, { sessionFile });
      await readTaskProgressSnapshot(task.id);
    }
    patchTask(task.id, { sessionFile: join(root, "session-0.jsonl") });
    await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 10, "oldest retained transcript must be evicted");
    const large = join(root, "large.jsonl");
    writeFileSync(large, Buffer.alloc(2 * 1024 * 1024 + 1));
    patchTask(task.id, { sessionFile: large });
    await readTaskProgressSnapshot(task.id);
    await readTaskProgressSnapshot(task.id);
    assert.equal(opened, 12, "large transcript must not be retained");
  });
});
