import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { captureRevertLeafId, imagesFromEntry, messageEntryById, persistHangRetryCount, persistManualAbortedAssistantId, persistRevertLeafId, restoreExactSessionLeaf, unrevertTask } from "./harness";

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

describe("messageEntryById", () => {
  function mockEntries(entries: unknown[]) {
    return {
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => entries,
      },
    };
  }

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
