import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ getTask: vi.fn(), getProject: vi.fn(), listProjects: vi.fn(() => []) }));
vi.mock("@/lib/store", () => store);
import { readTaskLocalImage } from "@/lib/local-image";
import { registerShowImage } from "./show-image";

let root: string;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-show-image-sdk-"));
  store.getTask.mockReturnValue({ id: "task", projectId: null, directory: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function createSession(path: string, finalReply: string) {
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(api) => registerShowImage(api, {
      validate: (path) => readTaskLocalImage("task", path),
    })],
  });
  await loader.reload();
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("show_image", { images: [{ path, alt: "完成画像" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage(finalReply),
    fauxAssistantMessage("次の回答"),
  ]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.inMemory(root), modelRuntime, model: faux.getModel(), tools: ["show_image"],
  });
  await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
  return session;
}

it("repairs and persists the reply through real SDK message_end without skills or extra provider requests", async () => {
  writeFileSync(join(root, "render.png"), png);
  const session = await createSession("render.png", "生成完了。render.pngに保存した。");
  const ended: string[] = [];
  session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      ended.push(event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    }
  });
  try {
    await session.prompt("画像を見せて");
    const final = session.messages.at(-1);
    expect(JSON.stringify(final)).toContain("![完成画像](<render.png>)");
    expect(ended.at(-1)).toContain("![完成画像](<render.png>)");
    expect(JSON.stringify(session.sessionManager.getBranch())).toContain("![完成画像](<render.png>)");
    await session.prompt("次の質問");
    expect(JSON.stringify(session.messages.at(-1))).not.toContain("render.png");
  } finally { session.dispose(); }
});

it.each(["missing.png", "fake.png", "vector.svg", "https://example.com/render.png", "\\\\server\\share\\render.png"])(
  "rejects non-displayable paths through the actual task image validator: %s", async (path) => {
    writeFileSync(join(root, "fake.png"), "not an image");
    writeFileSync(join(root, "vector.svg"), "<svg/>");
    const session = await createSession(path, "画像は表示できなかった。");
    try {
      await session.prompt("画像を見せて");
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ isError: true });
      expect(JSON.stringify(session.messages.at(-1))).not.toContain("![");
    } finally { session.dispose(); }
  },
);
