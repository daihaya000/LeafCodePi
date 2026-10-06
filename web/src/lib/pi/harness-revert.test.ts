import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { EventEmitter } from "node:events";
import { revertTask, captureRevertLeafId, filesFromEntry, imagesFromEntry, messageEntryById, persistHangRetryCount, persistManualAbortedAssistantId, persistRevertLeafId, restoreExactSessionLeaf, unrevertTask } from "./harness";

describe("rewind branch and attachment regressions", () => {
  it("maps a legacy msg-N against the active branch rather than every historical branch", () => {
    const old = { type: "message", id: "old", message: { role: "user", content: "discarded" } };
    const current = { type: "message", id: "current", message: { role: "user", content: "current" } };
    const session = { sessionManager: { getEntries: () => [old, current], getBranch: () => [current] } };
    assert.equal(messageEntryById(session as never, "msg-0")?.id, "current");
  });
  it("restores file attachments from SDK text blocks as well as string content", async () => {
    const { formatPromptWithFiles } = await import("@/lib/prompt-images");
    const text = formatPromptWithFiles("review", [{ name: "note.txt", mimeType: "text/plain", data: Buffer.from("contents").toString("base64") }]);
    const entry = { message: { role: "user", content: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "AAEC" }] } };
    assert.equal(filesFromEntry(entry)[0]?.name, "note.txt");
  });
});

describe("captureRevertLeafId", () => {
  it("keeps the pre-navigate leaf id (not the post-navigate position)", () => {
    const before = "leaf-tip-with-discarded-messages";
    const afterNavigate = "leaf-at-parent-user-message";
    assert.equal(captureRevertLeafId(before), before);
    assert.notEqual(captureRevertLeafId(before), afterNavigate);
  });
});

describe("restoreExactSessionLeaf", () => {
  it("restores a user entry target and rebuilds the agent context", () => {
    let leaf = "parent";
    const contextMessages = [{ role: "user", content: "original" }];
    const session = {
      sessionManager: {
        getLeafId: () => leaf,
        getEntry: (id: string) => id === "user" ? { type: "message" } : undefined,
        branch: (id: string) => { leaf = id; },
        buildSessionContext: () => ({ messages: contextMessages }),
      },
      agent: { state: { messages: [] as unknown[] } },
    };

    restoreExactSessionLeaf(session as never, "user");

    assert.equal(leaf, "user");
    assert.deepEqual(session.agent.state.messages, contextMessages);
  });

  it("does not rebuild an already restored leaf", () => {
    let rebuilt = false;
    const session = {
      sessionManager: {
        getLeafId: () => "leaf",
        getEntry: () => undefined,
        branch: () => { throw new Error("should not branch"); },
        buildSessionContext: () => { rebuilt = true; return { messages: [] }; },
      },
      agent: { state: { messages: [] as unknown[] } },
    };

    restoreExactSessionLeaf(session as never, "leaf");

    assert.equal(rebuilt, false);
  });
});

describe("unrevertTask", () => {
  it.each(["cancelled", "failed"])("keeps the restore marker when navigation is %s", async (outcome) => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), `leafcode-pi-unrevert-${outcome}-`));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    const globalRef = globalThis as Record<string, unknown>;
    const globalKey = "__leafcodePiHarness";
    const previousHarness = globalRef[globalKey];
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    try {
      const { upsertProject, insertTask, getTask } = await import("@/lib/store");
      const project = upsertProject({ name: "demo", rootPath: root });
      const task = insertTask({ project, title: "unrevert" });
      const session = {
        isStreaming: false,
        navigateTree: async () => {
          if (outcome === "failed") throw new Error("navigation failed");
          return { cancelled: true };
        },
      };
      globalRef[globalKey] = {
        live: new Map([[task.id, { revertLeafId: "original-leaf", session }]]),
      };
      const { patchTask } = await import("@/lib/store");
      patchTask(task.id, { revertLeafId: "original-leaf" });

      await assert.rejects(unrevertTask(task.id));
      assert.equal(getTask(task.id)?.revertLeafId, "original-leaf");
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      if (previousHarness === undefined) delete globalRef[globalKey];
      else globalRef[globalKey] = previousHarness;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects restore while the session is streaming", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-unrevert-streaming-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    const globalRef = globalThis as Record<string, unknown>;
    const globalKey = "__leafcodePiHarness";
    const previousHarness = globalRef[globalKey];
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    try {
      const { upsertProject, insertTask, getTask, patchTask } = await import("@/lib/store");
      const project = upsertProject({ name: "demo", rootPath: root });
      const task = insertTask({ project, title: "unrevert streaming" });
      let navigated = false;
      globalRef[globalKey] = {
        live: new Map([[task.id, {
          revertLeafId: "original-leaf",
          session: {
            isStreaming: true,
            sessionId: "sess-stream",
            sessionManager: { getCwd: () => root },
            navigateTree: async () => {
              navigated = true;
              return { cancelled: false };
            },
          },
        }]]),
      };
      patchTask(task.id, { revertLeafId: "original-leaf" });

      await assert.rejects(unrevertTask(task.id), /応答中は巻き戻せません/);
      assert.equal(navigated, false);
      assert.equal(getTask(task.id)?.revertLeafId, "original-leaf");
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      if (previousHarness === undefined) delete globalRef[globalKey];
      else globalRef[globalKey] = previousHarness;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops an owned Goal Loop then restores the leaf", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-unrevert-goal-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    const globalRef = globalThis as Record<string, unknown>;
    const globalKey = "__leafcodePiHarness";
    const previousHarness = globalRef[globalKey];
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    try {
      const { upsertProject, insertTask, getTask, patchTask } = await import("@/lib/store");
      const project = upsertProject({ name: "demo", rootPath: root });
      const task = insertTask({ project, title: "unrevert goal" });
      patchTask(task.id, { revertLeafId: "original-leaf", sessionId: "sess-goal" });
      mkdirSync(join(root, "data", "goals-loop"), { recursive: true });
      const loopFile = join(root, "data", "goals-loop", "sess-goal.json");
      const loop = {
        id: "loop-1",
        sessionId: "sess-goal",
        cwd: root,
        status: "queued",
        goal: "ship",
        acceptance: [],
        maxTurns: 3,
        cooldownSeconds: 1,
        nextTurnAt: null,
        forceFullRun: false,
        turnCount: 1,
        turnKind: "goal",
        pauseReason: "",
        error: "",
        progress: [],
        summary: "",
        evidence: "",
        blockedReason: "",
        rejectedClaims: 0,
        unreadableStreak: 0,
      };
      writeFileSync(loopFile, JSON.stringify(loop));
      let navigated = false;
      let leaf = "parent";
      globalRef[globalKey] = {
        events: new EventEmitter(),
        live: new Map([[task.id, {
          taskId: task.id,
          revertLeafId: "original-leaf",
          accountId: null,
          agentName: null,
          accountByMessageId: new Map(),
          agentByMessageId: new Map(),
          throughputByStartedAt: new Map(),
          toolStartedAt: new Map(),
          toolEndedAt: new Map(),
          toolPartialOutputByCallId: new Map(),
          session: {
            isStreaming: false,
            sessionId: "sess-goal",
            messages: [],
            extensionRunner: {
              getCommand: (name: string) => name === "goal-stop"
                ? {
                  handler: async () => {
                    writeFileSync(loopFile, JSON.stringify({ ...loop, status: "stopped" }));
                  },
                }
                : undefined,
              createCommandContext: () => ({}),
            },
            sessionManager: {
              getCwd: () => root,
              getLeafId: () => leaf,
              getEntry: (id: string) => id === "original-leaf" ? { type: "message" } : undefined,
              getBranch: () => [],
              getEntries: () => [],
              branch: (id: string) => { leaf = id; },
              buildSessionContext: () => ({ messages: [] }),
            },
            agent: { state: { messages: [] } },
            navigateTree: async () => {
              navigated = true;
              return { cancelled: false };
            },
          },
        }]]),
      };

      await unrevertTask(task.id);
      assert.equal(navigated, true);
      assert.equal(leaf, "original-leaf");
      assert.equal(getTask(task.id)?.revertLeafId, null);
      assert.equal(JSON.parse(readFileSync(loopFile, "utf8")).status, "stopped");
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      if (previousHarness === undefined) delete globalRef[globalKey];
      else globalRef[globalKey] = previousHarness;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("persistRevertLeafId", () => {
  it("writes the leaf onto the task record so restore survives a live restart", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), `leafcode-pi-revert-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const { upsertProject, insertTask, getTask } = await import("@/lib/store");
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = insertTask({ project, title: "revert persist" });

    persistRevertLeafId(task.id, "leaf-tip");
    assert.equal(getTask(task.id)?.revertLeafId, "leaf-tip");
    persistRevertLeafId(task.id, null);
    assert.equal(getTask(task.id)?.revertLeafId, null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("persistManualAbortedAssistantId", () => {
  it("keeps the empty-string sentinel so resume survives a live restart", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), `leafcode-pi-abort-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const { upsertProject, insertTask, getTask } = await import("@/lib/store");
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = insertTask({ project, title: "abort persist" });

    persistManualAbortedAssistantId(task.id, "");
    assert.equal(getTask(task.id)?.manualAbortedAssistantId, "");
    persistManualAbortedAssistantId(task.id, null);
    assert.equal(getTask(task.id)?.manualAbortedAssistantId, null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("persistHangRetryCount", () => {
  it("writes the retry count onto the task record so the notice survives a live restart", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = join(tmpdir(), `leafcode-pi-hang-retry-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    process.env.LEAFCODE_PI_DATA_DIR = dir;
    const { upsertProject, insertTask, getTask } = await import("@/lib/store");
    const project = upsertProject({ name: "demo", rootPath: dir });
    const task = insertTask({ project, title: "hang retry persist" });

    persistHangRetryCount(task.id, 2);
    assert.equal(getTask(task.id)?.hangRetryCount, 2);
    persistHangRetryCount(task.id, 0);
    assert.equal(getTask(task.id)?.hangRetryCount, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("revertTask Goal Loop prompts", () => {
  it("navigates the custom entry, preserves restoration and returns only the user goal and image", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "leafcode-pi-revert-goal-"));
    const previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    const globalRef = globalThis as Record<string, unknown>;
    const previousHarness = globalRef.__leafcodePiHarness;
    process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
    try {
      const { upsertProject, insertTask, getTask } = await import("@/lib/store");
      const project = upsertProject({ name: "demo", rootPath: root });
      const task = insertTask({ project, title: "Goal Loop rewind" });
      const image = { type: "image", mimeType: "image/png", data: "AAEC" };
      const entry = {
        type: "custom_message", id: "goal-entry", parentId: "before-goal",
        customType: "leafcode-goal-turn", display: false,
        content: [{ type: "text", text: "internal scheduler instructions" }, image],
        details: { uiPrompt: "画像を確認", goalId: "goal-1", turn: 1, kind: "goal" },
      };
      let leaf = "original-leaf";
      let navigated: string | undefined;
      const session = {
        sessionId: "stopped-goal-session", isStreaming: false, isCompacting: false,
        messages: [], agent: { state: { messages: [] } },
        sessionManager: {
          getEntries: () => [entry], getBranch: () => [], getCwd: () => root, getLeafId: () => leaf,
        },
        navigateTree: async (id: string) => {
          navigated = id;
          leaf = entry.parentId;
          return { cancelled: false, editorText: "internal scheduler instructions" };
        },
      };
      globalRef.__leafcodePiHarness = {
        events: new EventEmitter(),
        live: new Map([[task.id, {
          taskId: task.id, session, accountId: null, agentName: null,
          accountByMessageId: new Map(), agentByMessageId: new Map(),
          throughputByStartedAt: new Map(), toolStartedAt: new Map(),
          toolEndedAt: new Map(), toolPartialOutputByCallId: new Map(),
        }]]),
      };
      const result = await revertTask(task.id, entry.id);
      assert.equal(navigated, entry.id);
      assert.equal(leaf, "before-goal");
      assert.equal(getTask(task.id)?.revertLeafId, "original-leaf");
      assert.equal(result.text, "画像を確認");
      assert.equal(result.images[0]?.uri, "data:image/png;base64,AAEC");
      assert.equal(result.task.revertLeafId, "original-leaf");
      assert.ok(!JSON.stringify(result).includes("internal scheduler instructions"));
    } finally {
      if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
      else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
      if (previousHarness === undefined) delete globalRef.__leafcodePiHarness;
      else globalRef.__leafcodePiHarness = previousHarness;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("messageEntryById", () => {
  function mockEntries(entries: unknown[]) {
    return {
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => entries,
      },
    };
  }

  it("uses the SDK entry index without copying or scanning the full history", () => {
    let lookups = 0;
    const entry = { type: "message", id: "indexed", message: { role: "user", content: "hello" } };
    const session = { sessionManager: {
      getEntry: (id: string) => { lookups += 1; return id === entry.id ? entry : undefined; },
      getEntries: () => { throw new Error("full-history copy must not be used"); },
    } };
    assert.equal(messageEntryById(session as never, "indexed")?.id, "indexed");
    assert.equal(messageEntryById(session as never, "missing"), null);
    assert.equal(lookups, 2);
  });

  it("resolves legacy ids from the active branch without copying full history", () => {
    const entry = { type: "message", id: "active", message: { role: "user", content: "hello" } };
    const session = { sessionManager: {
      getEntry: () => undefined,
      getBranch: () => [entry],
      getEntries: () => { throw new Error("full-history copy must not be used"); },
    } };
    assert.equal(messageEntryById(session as never, "msg-0")?.id, "active");
  });

  it("finds the session entry by entry id (UiMessage.id carries the entry id)", () => {
    const session = mockEntries([
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
      { type: "message", id: "e2", message: { role: "assistant", content: "hi" } },
    ]);
    const found = messageEntryById(session as never, "e2");
    assert.ok(found);
    assert.equal(found.id, "e2");
    assert.equal(found.message.role, "assistant");
  });

  it("resolves the visible Goal Loop prompt to its custom session entry", () => {
    const session = mockEntries([{
      type: "custom_message", id: "goal-entry", customType: "leafcode-goal-turn",
      content: "internal scheduler instructions", display: false,
      details: { goalId: "goal-1", turn: 1, kind: "goal", uiPrompt: "ユーザーの目標" },
    }]);
    const found = messageEntryById(session as never, "goal-entry");
    assert.ok(found);
    assert.equal(found.id, "goal-entry");
    assert.deepEqual(found.message, { role: "user", content: "ユーザーの目標" });
    assert.equal(found.editorText, "ユーザーの目標");
  });

  it("keeps initial Goal Loop images but excludes internal instruction text", () => {
    const image = { type: "image", mimeType: "image/png", data: "AAEC", filename: "goal.png" };
    const session = mockEntries([{
      type: "custom_message", id: "goal-image", customType: "leafcode-goal-turn",
      content: [{ type: "text", text: "internal instructions" }, image],
      details: { uiPrompt: "画像を確認" },
    }]);
    const found = messageEntryById(session as never, "goal-image");
    assert.ok(found);
    assert.deepEqual(found.message.content, [{ type: "text", text: "画像を確認" }, image]);
    assert.deepEqual(imagesFromEntry(found), [{ uri: "data:image/png;base64,AAEC", mime: "image/png", name: "goal.png" }]);
  });

  it.each([
    { customType: "leafcode-goal-turn", details: {} },
    { customType: "leafcode-goal-verification", details: { uiPrompt: "hidden" } },
    { customType: "leafcode-goal-loop-ended", details: { uiPrompt: "hidden" } },
    { customType: "unrelated", details: { uiPrompt: "hidden" } },
  ])("does not make hidden custom messages reversible: $customType", (entry) => {
    const session = mockEntries([{ type: "custom_message", id: "hidden", content: "internal instructions", ...entry }]);
    assert.equal(messageEntryById(session as never, "hidden"), null);
  });

  it("resolves legacy `msg-N` ids against branch message order", () => {
    const session = mockEntries([
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
      { type: "message", id: "e2", message: { role: "assistant", content: "hi" } },
    ]);
    const found = messageEntryById(session as never, "msg-1");
    assert.ok(found);
    assert.equal(found.id, "e2");
  });

  it("returns null for unknown ids", () => {
    const session = mockEntries([
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
    ]);
    assert.equal(messageEntryById(session as never, "nope"), null);
    assert.equal(messageEntryById(session as never, "msg-9"), null);
  });

  it("ignores non-message entries", () => {
    const session = mockEntries([
      { type: "compaction", id: "c1", summary: "x", firstKeptEntryId: "e2", tokensBefore: 1 },
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
    ]);
    assert.equal(messageEntryById(session as never, "c1"), null);
    const found = messageEntryById(session as never, "e1");
    assert.ok(found);
    assert.equal(found.id, "e1");
  });
});

describe("imagesFromEntry", () => {
  it("extracts image blocks as composer attachments", () => {
    const entry = {
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "AAEC", filename: "shot.png" },
        ],
      },
    };
    const images = imagesFromEntry(entry);
    assert.equal(images.length, 1);
    assert.equal(images[0].uri, "data:image/png;base64,AAEC");
    assert.equal(images[0].mime, "image/png");
    assert.equal(images[0].name, "shot.png");
  });

  it("defaults mime and name for bare image blocks", () => {
    const entry = { message: { role: "user", content: [{ type: "image", data: "xyz" }] } };
    const images = imagesFromEntry(entry);
    assert.equal(images.length, 1);
    assert.equal(images[0].mime, "image/png");
    assert.equal(images[0].name, "image-1");
  });

  it("returns [] for text-only content", () => {
    const entry = { message: { role: "user", content: [{ type: "text", text: "hi" }] } };
    assert.deepEqual(imagesFromEntry(entry), []);
  });
});
