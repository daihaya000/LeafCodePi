import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTask, insertTask, listTasks, patchTask, upsertProject } from "@/lib/store";
import { formatPromptWithFiles } from "@/lib/prompt-images";

const control = vi.hoisted(() => ({ busy: false, compacting: false, attention: false, gate: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock("@/lib/pi/harness", async (original) => {
  const actual = await original<typeof import("@/lib/pi/harness")>();
  return {
    ...actual,
    getTaskDetailReadOnly: async (id: string) => {
      if (control.gate) { control.entered?.(); await control.gate; }
      const task = getTask(id)!;
      const manager = SessionManager.open(task.sessionFile!);
      return {
        ...task, isStreaming: control.busy, isCompacting: control.compacting, permissionRequest: control.attention ? { id: "approval" } : null,
        messages: manager.getBranch().filter((entry) => entry.type === "message" || (entry.type === "custom_message" && entry.customType === "leafcode-goal-turn"))
          .map((entry) => ({ id: entry.id, role: entry.type === "message" ? entry.message.role : "user" })),
      };
    },
  };
});

import { forkTask } from "./task-fork";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-fork-"));
  process.env.LEAFCODE_PI_DATA_DIR = join(root, "data");
  process.env.LEAFCODE_PI_DEFAULT_DIR = join(root, "workspace");
  control.busy = false; control.compacting = false; control.attention = false; control.gate = null; control.entered = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LEAFCODE_PI_DATA_DIR; delete process.env.LEAFCODE_PI_DEFAULT_DIR;
  rmSync(root, { recursive: true, force: true });
});

function fixture(project = false) {
  const task = insertTask({
    project: project ? upsertProject({ rootPath: join(root, "project") }) : null,
    title: "元の会話", providerID: "openai", modelID: "test-model", thinkingLevel: "high",
    accountId: "test-account", accountIdExplicit: true, agent: "reviewer", permissionMode: "ask", skillPermission: "deny",
  });
  const manager = SessionManager.create(task.directory, join(root, "sessions"));
  const first = manager.appendMessage({ role: "user", content: "最初の案", timestamp: 1 });
  const assistant = manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "応答A" }], api: "openai-responses", provider: "openai", model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2,
  });
  const next = manager.appendMessage({ role: "user", content: [{ type: "text", text: "別の指示" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], timestamp: 3 });
  manager.appendMessage({ role: "user", content: "これはコピーしない", timestamp: 4 });
  patchTask(task.id, { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()! });
  return { task: getTask(task.id)!, manager, first, assistant, next };
}

describe("forkTask", () => {
  it.each([false, true])("copies only ancestors and preserves settings/workspace (project=%s)", async (project) => {
    const { task, manager, next } = fixture(project);
    const before = readFileSync(task.sessionFile!, "utf8");
    const leaf = manager.getLeafId();
    const result = await forkTask(task.id, next);
    expect(result.text).toBe("別の指示");
    expect(result.images).toEqual([{ uri: "data:image/png;base64,aW1hZ2U=", mime: "image/png", name: "image-2" }]);
    expect(result.files).toEqual([]);
    expect(result.task.id).not.toBe(task.id);
    expect(result.task.sessionId).not.toBe(task.sessionId);
    expect(result.task).toMatchObject({
      projectId: task.projectId, directory: task.directory, status: "idle", title: "元の会話（分岐）",
      providerID: "openai", modelID: "test-model", accountId: "test-account", accountIdExplicit: true,
      thinkingLevel: "high", agent: "reviewer", permissionMode: "ask", skillPermission: "deny",
    });
    const copied = SessionManager.open(result.task.sessionFile!);
    expect(copied.buildSessionContext().messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(copied.getHeader()?.parentSession).toBe(task.sessionFile);
    expect(copied.getEntries().some((entry) => entry.id === next)).toBe(false);
    expect(readFileSync(task.sessionFile!, "utf8")).toBe(before);
    expect(manager.getLeafId()).toBe(leaf);
    expect(getTask(task.id)).toEqual(task);
  });

  it("persists an empty fork of the first root input, including lineage", async () => {
    const { task, first } = fixture();
    const result = await forkTask(task.id, first);
    expect(existsSync(result.task.sessionFile!)).toBe(true);
    const copied = SessionManager.open(result.task.sessionFile!);
    expect(copied.getSessionId()).toBe(result.task.sessionId);
    expect(copied.buildSessionContext().messages).toEqual([]);
    expect(copied.getHeader()?.parentSession).toBe(task.sessionFile);
    expect(result.text).toBe("最初の案");
  });

  it("forks a Goal Loop user input without restoring the hidden scheduler prompt or loop ownership", async () => {
    const { task, manager } = fixture();
    const target = manager.appendCustomMessageEntry("leafcode-goal-turn", [
      { type: "text", text: "秘密ではない内部scheduler指示" },
      { type: "image", data: "YQ==", mimeType: "image/png" },
    ], false, { uiPrompt: "ユーザーの目標", turn: 1, kind: "goal" });
    const result = await forkTask(task.id, target);
    expect(result.text).toBe("ユーザーの目標");
    expect(result.images).toEqual([{ uri: "data:image/png;base64,YQ==", mime: "image/png", name: "image-2" }]);
    expect(result.task.sessionId).not.toBe(task.sessionId);
    expect(result.task.goalLoopSummary).toBeUndefined();
    expect(SessionManager.open(result.task.sessionFile!).getEntry(target)).toBeUndefined();
  });

  it("restores UTF-8 file attachments into the draft, not duplicated conversation content", async () => {
    const { task, manager } = fixture();
    const content = Buffer.from("日本語のファイル", "utf8").toString("base64");
    const target = manager.appendMessage({ role: "user", content: formatPromptWithFiles("変更して", [{ name: "案.txt", mimeType: "text/plain", data: content }]), timestamp: 5 });
    const result = await forkTask(task.id, target);
    expect(result.text).toBe("変更して");
    expect(result.files).toEqual([{ name: "案.txt", mime: "text/plain", uri: `data:text/plain;base64,${content}` }]);
  });

  it.each(["streaming", "compacting", "working", "attention"])("rejects %s without registering a task", async (mode) => {
    const { task, next } = fixture();
    control.busy = mode === "streaming"; control.compacting = mode === "compacting";
    control.attention = mode === "attention";
    if (mode === "working") patchTask(task.id, { status: mode });
    await expect(forkTask(task.id, next)).rejects.toMatchObject({ status: 409 });
    expect(listTasks(true)).toHaveLength(1);
  });

  it("rejects unknown/assistant/inactive branch IDs and Bot tasks", async () => {
    const { task, manager, next, assistant } = fixture();
    for (const target of ["missing", assistant]) await expect(forkTask(task.id, target)).rejects.toMatchObject({ status: 404 });
    manager.branch(assistant);
    manager.appendMessage({ role: "user", content: "別ブランチ", timestamp: 5 });
    await expect(forkTask(task.id, next)).rejects.toMatchObject({ status: 404 });
    const store = await import("@/lib/store");
    vi.spyOn(store, "getTask").mockReturnValueOnce({ ...task, kind: "bot" });
    await expect(forkTask(task.id, next)).rejects.toMatchObject({ status: 400 });
    await expect(forkTask("missing", next)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects duplicate forks while the source snapshot is being read", async () => {
    const { task, next } = fixture();
    let release!: () => void;
    control.gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { control.entered = resolve; });
    const operation = forkTask(task.id, next);
    await entered;
    await expect(forkTask(task.id, next)).rejects.toMatchObject({ status: 409 });
    release();
    await operation;
  });

  it("refuses a source task changed during its asynchronous snapshot read", async () => {
    const { task, next } = fixture();
    let release!: () => void;
    control.gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { control.entered = resolve; });
    const operation = forkTask(task.id, next);
    const refusal = expect(operation).rejects.toMatchObject({ status: 409 });
    await entered;
    patchTask(task.id, { title: "同時に変更されたタイトル" });
    release();
    await refusal;
    expect(listTasks(true)).toHaveLength(1);
    expect(getTask(task.id)?.title).toBe("同時に変更されたタイトル");
  });

  it("removes the newly created file when registration fails", async () => {
    const { task, next } = fixture();
    const before = readdirSync(join(root, "sessions"));
    const store = await import("@/lib/store");
    vi.spyOn(store, "insertTask").mockImplementationOnce(() => { throw new Error("registration failed"); });
    await expect(forkTask(task.id, next)).rejects.toThrow("registration failed");
    expect(readdirSync(join(root, "sessions"))).toEqual(before);
    expect(listTasks(true)).toHaveLength(1);
  });
});
