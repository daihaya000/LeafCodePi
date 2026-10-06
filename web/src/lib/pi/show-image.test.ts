import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { MAX_SHOWN_IMAGES, registerShowImage, registerShowVideo, registerShowAudio, shownImageMarkdown, type ImageValidation, type ShownImage } from "./show-image";

const image: ShownImage = { path: "renders/result.png", alt: "完成レンダー" };
const textMessage = (text: string, stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason,
});

type FinalResult = { message: ReturnType<typeof textMessage> } | undefined;
type TestTool = {
  executionMode?: string;
  execute: (id: string, params: Record<string, ShownImage[]>, signal?: AbortSignal) => Promise<{
    content: { type: string; text: string }[]; details: unknown;
  }>;
};

function fixture(branch: unknown[] = [], kind: "image" | "video" | "audio" = "image") {
  const name = `show_${kind}`;
  const field = kind === "image" ? "images" : kind === "video" ? "videos" : "audio";
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  let tool!: TestTool;
  let active = true;
  const validate = vi.fn<(path: string) => Promise<ImageValidation>>(async () => ({ ok: true }));
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => active ? [name] : [],
    registerTool: (definition: TestTool) => { tool = definition; },
  } as unknown as ExtensionAPI;
  ({ image: registerShowImage, video: registerShowVideo, audio: registerShowAudio })[kind](api, { validate });
  const emit = (name: string, event: unknown = {}) => handlers.get(name)!(event, {
    sessionManager: { getBranch: () => branch },
  });
  const execute = (images = [image], signal?: AbortSignal) => tool.execute("call", { [field]: images }, signal);
  const register = async (images = [image]) => {
    const result = await execute(images);
    emit("tool_result", { toolName: name, isError: false, ...result });
    return result;
  };
  const final = (text = "生成完了", reason = "stop") => emit("message_end", { message: textMessage(text, reason) }) as FinalResult;
  return { tool: () => tool, validate, emit, execute, register, final, disable: () => { active = false; } };
}

function repairedText(result: FinalResult): string {
  return result?.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

describe("show-image native policy", () => {
  it("repairs a path-only reply without an extra model turn", async () => {
    const run = fixture();
    await run.register();
    expect(repairedText(run.final())).toContain(shownImageMarkdown(image));
    expect(run.final()).toBeUndefined();
    expect(run.validate).toHaveBeenCalledOnce();
    expect(run.tool().executionMode).toBe("sequential");
  });

  it("does not publish images from read, inspect, or generation results without explicit registration", () => {
    const run = fixture();
    for (const toolName of ["read", "observe_ui", "render_image"]) {
      run.emit("tool_result", { toolName, details: { shownImages: [image] } });
    }
    expect(run.final()).toBeUndefined();
  });

  it.each([
    shownImageMarkdown(image),
    `![別の説明](${image.path})`,
    `![別の説明](<${image.path}>)`,
    `![別の説明][result]\n\n[result]: ${image.path}`,
  ])("does not duplicate an existing presentation: %s", async (markdown) => {
    const run = fixture();
    await run.register();
    expect(run.final(markdown)).toBeUndefined();
  });

  it.each([
    `\`\`\`markdown\n${shownImageMarkdown(image)}\n\`\`\``,
    `~~~markdown\n${shownImageMarkdown(image)}\n~~~`,
    `\`${shownImageMarkdown(image)}\``,
    `\\${shownImageMarkdown(image)}`,
    `\`\`\`markdown\n${shownImageMarkdown(image)}`,
    `    ${shownImageMarkdown(image)}`,
    `<!-- ${shownImageMarkdown(image)} -->`,
    `> \`\`\`markdown\n> ${shownImageMarkdown(image)}\n> \`\`\``,
  ])("repairs syntax mentioned only as code or escaped text: %s", async (example) => {
    const run = fixture();
    await run.register();
    expect(repairedText(run.final(example))).toContain(shownImageMarkdown(image));
    expect(run.final()).toBeUndefined();
  });

  it("encodes unsafe paths and alt text, including spaces, Japanese, percent signs and parentheses", async () => {
    const special = { path: "C:\\images\\結果 (100%).png", alt: "A] [B\\C\n説明" };
    const markdown = shownImageMarkdown(special);
    expect(markdown).toContain("%20%28100%25%29.png");
    expect(markdown).toContain("A\\] \\[B\\\\C 説明");
    const run = fixture();
    await run.register([special]);
    expect(run.final(markdown)).toBeUndefined();
  });

  it("never repairs intermediate tool calls, aborted responses or errors", async () => {
    const run = fixture();
    await run.register();
    for (const reason of ["toolUse", "aborted", "error"]) expect(run.final("", reason)).toBeUndefined();
    expect(repairedText(run.final())).toContain(shownImageMarkdown(image));
  });

  it("discards pending images for a new task but preserves steer and extension continuations", async () => {
    const run = fixture();
    await run.register();
    run.emit("input", { source: "extension", text: "継続" });
    run.emit("input", { source: "interactive", text: "補足", streamingBehavior: "steer" });
    expect(repairedText(run.final())).toContain(shownImageMarkdown(image));
    await run.register();
    run.emit("input", { source: "interactive", text: "新しい依頼" });
    expect(run.final()).toBeUndefined();
  });

  it.each(["画像は表示不要", "画像は表示しないで", "画像不要", "Don't show images"]) (
    "honors an explicit display opt-out: %s", async (text) => {
      const run = fixture();
      await run.register();
      run.emit("input", { source: "interactive", text, streamingBehavior: "followUp" });
      await expect(run.execute()).rejects.toThrow("不要");
      expect(run.final()).toBeUndefined();
    },
  );

  it("does not mistake a no-code-display request for an image opt-out", async () => {
    const run = fixture();
    run.emit("input", { source: "interactive", text: "コードは表示不要、画像を見せて" });
    await run.register();
    expect(repairedText(run.final())).toContain(shownImageMarkdown(image));
  });

  it("respects tool permissions even if images were previously registered", async () => {
    const run = fixture();
    await run.register();
    run.disable();
    await expect(run.execute()).rejects.toThrow("無効");
    expect(run.final()).toBeUndefined();
    const disabledRestore = fixture([{ type: "message", message: {
      role: "toolResult", toolName: "show_image", details: { shownImages: [image] },
    } }]);
    disabledRestore.disable();
    await disabledRestore.emit("session_start");
    expect(disabledRestore.validate).not.toHaveBeenCalled();
    expect(disabledRestore.final()).toBeUndefined();
  });

  it("fails atomically for invalid files and does not remember error results", async () => {
    const run = fixture();
    run.validate.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("画像が見つかりません"));
    await expect(run.execute([image, { ...image, path: "missing.png" }])).rejects.toThrow("見つかりません");
    run.emit("tool_result", { toolName: "show_image", isError: true, details: { shownImages: [image] } });
    expect(run.final()).toBeUndefined();
  });

  it("deduplicates and caps registrations across calls", async () => {
    const run = fixture();
    const images = Array.from({ length: MAX_SHOWN_IMAGES }, (_, index) => ({ ...image, path: `img-${index}.png` }));
    await run.register(images);
    await run.register([images[0]]);
    await expect(run.execute([image])).rejects.toThrow("8件");
    const result = repairedText(run.final());
    expect(result.match(/!\[/g)).toHaveLength(MAX_SHOWN_IMAGES);
  });

  it("rejects stale validation and aborted execution", async () => {
    const run = fixture();
    let resolve!: (value: { ok: true }) => void;
    run.validate.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const result = run.execute();
    run.emit("input", { source: "interactive", text: "新しい依頼" });
    resolve({ ok: true });
    await expect(result).rejects.toThrow("依頼が変更");
    const controller = new AbortController();
    controller.abort();
    await expect(run.execute([image], controller.signal)).rejects.toThrow();
  });

  it("reconstructs only this branch's unfinished presentation and clears completed replies", async () => {
    const entry = { type: "message", message: {
      role: "toolResult", toolName: "show_image", details: { shownImages: [image] },
    } };
    const pending = fixture([entry]);
    await pending.emit("session_start");
    expect(repairedText(pending.final())).toContain(shownImageMarkdown(image));
    const completed = fixture([entry, { type: "message", message: textMessage("done") }]);
    await completed.emit("session_tree");
    expect(completed.final()).toBeUndefined();
    const stale = fixture([entry, { type: "message", message: { role: "user", content: "新しい依頼" } }]);
    await stale.emit("session_start");
    expect(stale.final()).toBeUndefined();
  });

  it("revalidates restored files and refuses invalid or forbidden historical paths", async () => {
    const entry = { type: "message", message: {
      role: "toolResult", toolName: "show_image", details: { shownImages: [image] },
    } };
    const run = fixture([entry]);
    run.validate.mockResolvedValueOnce({ ok: false, error: "表示できません" });
    await run.emit("session_tree");
    expect(run.validate).toHaveBeenCalledWith(image.path);
    expect(run.final()).toBeUndefined();
  });

  it("refuses blank alt text and a validator's explicit failure", async () => {
    const run = fixture();
    await expect(run.execute([{ ...image, alt: "  " }])).rejects.toThrow("説明文");
    run.validate.mockResolvedValueOnce({ ok: false, error: "許可パス外" });
    await expect(run.execute()).rejects.toThrow("許可パス外");
    expect(run.final()).toBeUndefined();
  });

  it("does not apply another media kind\'s opt-out to an image in the same sentence", async () => {
    const run = fixture();
    run.emit("input", { source: "interactive", text: "画像を見せて、音声表示不要。" });
    await run.register();
    expect(repairedText(run.final())).toContain(shownImageMarkdown(image));
  });

  it("injects presentation guidance independently of skill discovery", () => {
    const run = fixture();
    const result = run.emit("before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("base");
    expect(result.systemPrompt).toContain("call show_image");
    expect(result.systemPrompt).toContain("Without show_image");
    run.disable();
    const disabled = run.emit("before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string };
    expect(disabled.systemPrompt).not.toContain("call show_image");
    expect(disabled.systemPrompt).toContain("Without show_image");
  });
});

describe.each(["video", "audio"] as const)("show_%s native policy", (kind) => {
  const noun = kind === "video" ? "動画" : "音声";
  const media = { path: kind === "video" ? "renders/clip.mp4" : "music.wav", alt: `完成${noun}` };
  it("validates, repairs only explicit registrations, and does not duplicate embedded media", async () => {
    const run = fixture([], kind);
    run.emit("tool_result", { toolName: "generate_media", details: { shownVideos: [media], shownAudio: [media] } });
    expect(run.final()).toBeUndefined();
    await run.register([media]);
    expect(repairedText(run.final())).toContain(shownImageMarkdown(media));
    await run.register([media]);
    expect(run.final(shownImageMarkdown(media))).toBeUndefined();
    expect(run.validate).toHaveBeenCalledWith(media.path);
  });
  it("repairs code-only mentions, respects tool permissions and resets for new requests", async () => {
    const run = fixture([], kind);
    await run.register([media]);
    expect(repairedText(run.final(`\`${shownImageMarkdown(media)}\``))).toContain(shownImageMarkdown(media));
    await run.register([media]);
    run.emit("input", { source: "interactive", text: "次の質問" });
    expect(run.final()).toBeUndefined();
    run.disable();
    await expect(run.execute([media])).rejects.toThrow("無効");
  });
  it("respects kind-specific opt-out without suppressing a different media kind", async () => {
    const run = fixture([], kind);
    run.emit("input", { source: "interactive", text: `${kind === "video" ? "音声" : "動画"}表示不要` });
    await run.register([media]);
    expect(repairedText(run.final())).toContain(shownImageMarkdown(media));
    run.emit("input", { source: "interactive", streamingBehavior: "steer", text: `${noun}表示不要` });
    await expect(run.execute([media])).rejects.toThrow("不要");
    run.emit("input", { source: "interactive", streamingBehavior: "steer", text: `${noun}を表示して` });
    await run.register([media]);
    expect(repairedText(run.final())).toContain(shownImageMarkdown(media));
  });
  it("keeps separate clauses independent, respects combined opt-out and explicit playback requests", async () => {
    const run = fixture([], kind);
    run.emit("input", { source: "interactive", text: `${noun}を表示して、${kind === "video" ? "音声" : "動画"}表示不要。` });
    await run.register([media]);
    expect(repairedText(run.final())).toContain(shownImageMarkdown(media));
    run.emit("input", { source: "interactive", streamingBehavior: "steer", text: "動画/音声は表示不要" });
    await expect(run.execute([media])).rejects.toThrow("不要");
    run.emit("input", { source: "interactive", streamingBehavior: "steer", text: `${noun}を再生して` });
    await run.register([media]);
    expect(repairedText(run.final())).toContain(shownImageMarkdown(media));
  });

  it("revalidates incomplete historical registrations on branch restore", async () => {
    const detailsKey = kind === "video" ? "shownVideos" : "shownAudio";
    const run = fixture([{ type: "message", message: {
      role: "toolResult", toolName: `show_${kind}`, details: { [detailsKey]: [media] },
    } }], kind);
    await run.emit("session_tree");
    expect(repairedText(run.final())).toContain(shownImageMarkdown(media));
    const prompt = run.emit("before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string };
    expect(prompt.systemPrompt).toContain(`call show_${kind}`);
  });
});
