import { existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deleteTask, getProject, getTask, insertTask, patchTask } from "@/lib/store";
import { rawUserMessageText } from "@/lib/pi/messages";
import { parsePromptFileMarkers } from "@/lib/prompt-images";
import { readStoredPromptFileContent } from "@/lib/prompt-file-store";
import { filesFromEntry, getTaskDetailReadOnly, imagesFromEntry, messageEntryById, syncSessionName } from "@/lib/pi/harness";
import { assertLocalRuntimeAllowed } from "@/lib/pi/runtime-ownership";
import type { ForkTaskResult } from "@/lib/task-fork";

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

const forkSources = new Set<string>();

/** Extract the selected input's ancestors using a separate manager, never the live source manager. */
export async function forkTask(id: string, messageId: string): Promise<ForkTaskResult> {
  assertLocalRuntimeAllowed();
  if (forkSources.has(id)) fail("分岐処理中です。完了してからお試しください", 409);
  forkSources.add(id);
  try {
    const sourceRecord = getTask(id);
    if (!sourceRecord) fail("タスクが見つかりません", 404);
    // AppStore returns mutable records: retain a value snapshot across the asynchronous read.
    const source = { ...sourceRecord };
    if (source.kind === "bot" || id.startsWith("bot:")) fail("Codeセッションのみ分岐できます", 400);
    if (!source.sessionFile || !existsSync(source.sessionFile)) fail("セッション履歴が見つかりません", 404);
    const detail = await getTaskDetailReadOnly(id);
    if (detail.isStreaming || detail.isCompacting || detail.status === "working" || detail.permissionRequest || detail.questionRequest) {
      fail("処理中は分岐できません。停止してからお試しください", 409);
    }
    const current = getTask(id);
    if (!current) fail("タスクが見つかりません", 404);
    if (current.status === "working" || current.updatedAt !== source.updatedAt || current.sessionId !== source.sessionId ||
      current.sessionFile !== source.sessionFile || current.directory !== source.directory || current.projectId !== source.projectId) {
      fail("セッションが変更されました。再読み込みしてお試しください", 409);
    }
    // Reject stale/inactive-branch IDs, even though the append-only file still contains them.
    if (!detail.messages.some((message) => message.id === messageId && message.role === "user")) {
      fail("対象ユーザーメッセージが見つかりません", 404);
    }
    const manager = SessionManager.open(source.sessionFile);
    const input = messageEntryById({ sessionManager: manager } as Parameters<typeof messageEntryById>[0], messageId);
    if (!input || input.message.role !== "user") fail("対象ユーザーメッセージが見つかりません", 404);
    const entry = manager.getEntry(input.id);
    if (!entry) fail("対象メッセージが見つかりません", 404);
    const restored = parsePromptFileMarkers(input.editorText ?? rawUserMessageText(input.message), { readStored: readStoredPromptFileContent });
    const draft = { text: restored.text, images: imagesFromEntry(input), files: filesFromEntry(input) };
    const project = source.projectId ? getProject(source.projectId) : undefined;
    if (source.projectId && !project) fail("プロジェクトが見つかりません", 404);
    let file: string | undefined;
    let newTaskId: string | undefined;
    try {
      // First input can be a root entry: create an empty, independently persisted session.
      let forked: SessionManager;
      if (entry.parentId) {
        try { manager.createBranchedSession(entry.parentId); }
        finally { file = manager.getSessionFile(); }
        forked = manager;
      } else {
        forked = SessionManager.create(source.directory, manager.getSessionDir());
      }
      file = forked.getSessionFile();
      if (!file || file === source.sessionFile) fail("分岐先を作成できません", 500);
      const title = `${source.title}（分岐）`;
      syncSessionName(forked, title);
      // Pi defers writes until a conversation exists. Persist empty/metadata-only forks too.
      if (!existsSync(file)) {
        writeFileSync(file, [
          { ...forked.getHeader(), parentSession: source.sessionFile },
          ...forked.getEntries(),
        ].map((item) => JSON.stringify(item)).join("\n") + "\n", { flag: "wx" });
      }
      const created = insertTask({
        project: project ?? null, title, label: source.label,
        providerID: source.providerID, modelID: source.modelID, thinkingLevel: source.thinkingLevel,
        accountId: source.accountId, accountIdExplicit: source.accountIdExplicit,
        skillPermission: source.skillPermission, permissionMode: source.permissionMode,
        agent: source.agent ?? undefined,
      });
      newTaskId = created.id;
      const task = patchTask(created.id, {
        directory: source.directory, sessionId: forked.getSessionId(), sessionFile: file,
        ...(source.titleAutoUpdate !== undefined ? { titleAutoUpdate: source.titleAutoUpdate } : {}),
      });
      if (!task) fail("分岐先を登録できません", 500);
      return { task, ...draft };
    } catch (error) {
      if (newTaskId) deleteTask(newTaskId);
      if (file && file !== source.sessionFile) await rm(file, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    forkSources.delete(id);
  }
}
