import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fromMarkdown } from "mdast-util-from-markdown";
import { afterEach, expect, it, vi } from "vitest";
import { registerShowImage, registerShowVideo, registerShowAudio } from "./show-image";
vi.mock("mdast-util-from-markdown", async (original) => {
  const actual = await original<typeof import("mdast-util-from-markdown")>();
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) };
});
afterEach(() => vi.clearAllMocks());

it("all media kinds share hooks, one final AST and one input-state entry", async () => {
  type Result = { details: unknown; content: { type: string; text: string }[] };
  type Tool = { name: string; execute: (id: string, args: Record<string, unknown>) => Promise<Result> };
  type Handler = (event: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const on = vi.fn((name: string, handler: Handler) => handlers.set(name, handler));
  const appendEntry = vi.fn();
  const api = { on, appendEntry, getActiveTools: () => [...tools.keys()], registerTool: (tool: Tool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
  const options = { validate: () => ({ ok: true as const }) };
  registerShowImage(api, options);
  registerShowVideo(api, options);
  registerShowAudio(api, options);
  expect(on).toHaveBeenCalledTimes(6);
  handlers.get("input")!({ source: "interactive", text: "全て見せて" });
  expect(appendEntry).toHaveBeenCalledTimes(1);
  const files = [
    ["show_image", "images", "image.png"], ["show_video", "videos", "clip.mp4"], ["show_audio", "audio", "music.wav"],
  ];
  for (const [name, field, path] of files) {
    const result = await tools.get(name)!.execute(name, { [field]: [{ path, alt: name }] });
    handlers.get("tool_result")!({ toolName: name, isError: false, ...result });
  }
  const final = handlers.get("message_end")!({ message: {
    role: "assistant", stopReason: "stop", content: [{ type: "text", text: "完成" }],
  } });
  const serialized = JSON.stringify(final);
  for (const [name, , path] of files) expect(serialized).toContain(`![${name}](<${path}>)`);
  expect(fromMarkdown).toHaveBeenCalledTimes(1);
  handlers.get("input")!({ source: "interactive", text: "メディア表示不要" });
  for (const [name, field, path] of files) {
    await expect(tools.get(name)!.execute(name, { [field]: [{ path, alt: name }] })).rejects.toThrow("不要");
  }
});

it("restores media registered by independent API factories, including a later merged factory", async () => {
  type Result = { details: unknown };
  type Tool = { name: string; execute: (id: string, args: Record<string, unknown>) => Promise<Result> };
  type Handler = (event: unknown, ctx?: unknown) => unknown;
  const branch: unknown[] = [];
  const tools = new Map<string, Tool>();
  const fixture = () => {
    const handlers = new Map<string, Handler>();
    const api = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
      getActiveTools: () => ["show_image", "show_video"],
      registerTool: (tool: Tool) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    return { api, handlers };
  };
  const image = fixture();
  const video = fixture();
  const options = { validate: () => ({ ok: true as const }) };
  registerShowImage(image.api, options);
  registerShowVideo(video.api, options);
  for (const item of [image, video]) item.handlers.get("input")!({ source: "interactive", text: "画像と動画を見せて" });
  for (const [name, field, path] of [["show_image", "images", "image.png"], ["show_video", "videos", "clip.mp4"]]) {
    const result = await tools.get(name)!.execute(name, { [field]: [{ path, alt: name }] });
    branch.push({ type: "message", message: { role: "toolResult", toolName: name, ...result } });
  }
  const ctx = { sessionManager: { getBranch: () => branch } };
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "完成" }] };
  await image.handlers.get("session_tree")!({}, ctx);
  expect(JSON.stringify(image.handlers.get("message_end")!({ message }))).toContain("image.png");
  const merged = fixture();
  registerShowImage(merged.api, options);
  registerShowVideo(merged.api, options);
  await merged.handlers.get("session_tree")!({}, ctx);
  const final = JSON.stringify(merged.handlers.get("message_end")!({ message }));
  expect(final).toContain("image.png");
  expect(final).toContain("clip.mp4");
});
