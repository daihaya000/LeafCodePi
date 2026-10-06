import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fromMarkdown } from "mdast-util-from-markdown";

export const MAX_SHOWN_IMAGES = 8;
const DETAILS_KEY = "shownImages";
const HIDE_IMAGES = /(?:画像|スクリーンショット|レンダー).{0,12}(?:表示.{0,2}(?:不要|しない)|見せない|貼らない|埋め込まない|不要)|(?:do not|don't|no need to)\s+(?:show|display|embed)\s+(?:the\s+)?images?/i;
const SHOW_IMAGES = /(?:画像|スクリーンショット|レンダー).{0,12}(?:表示して|見せて|貼って)|(?:show|display|embed)\s+(?:the\s+)?images?/i;

export type ShownImage = { path: string; alt: string };
export type ImageValidation = { ok: true } | { ok: false; error: string };
export type ShowImageOptions = {
  /** Uses the task image endpoint's validator; this tool never grants filesystem access. */
  validate: (path: string) => ImageValidation | Promise<ImageValidation>;
};

const POLICY = [
  "Image presentation is handled by the harness, not just the show-image skill.",
  "When presenting generated images, renders or requested screenshots, call show_image with existing local paths and descriptive alt text. The harness adds validated images to the final reply if omitted.",
  "Do not end with only filenames or a generation-success report. Do not call show_image for internal inspection screenshots or when the user requested no images. Read/inspect an image first when visual verification is needed.",
  "Without show_image, use ![description](<local path>) explicitly. PNG/JPEG/GIF/WebP/AVIF/BMP up to 32 MB are supported; SVG and network paths are not. Remote URLs are click-to-load; do not put secrets in URLs. Keep displayed files in place.",
].join("\n");

/** Encoded destinations cannot close the Markdown image or inject additional markup. */
export function shownImageMarkdown(image: ShownImage): string {
  const alt = image.alt.replace(/[\r\n\u0000-\u001f]/g, " ").replace(/[\\[\]]/g, "\\$&");
  const destination = encodeURI(image.path.replace(/\\/g, "/")).replace(/[()<>]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `![${alt}](<${destination}>)`;
}

function imagesFromDetails(details: unknown): ShownImage[] {
  if (!details || typeof details !== "object") return [];
  const values = (details as Record<string, unknown>)[DETAILS_KEY];
  if (!Array.isArray(values)) return [];
  return values.slice(0, MAX_SHOWN_IMAGES).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const { path, alt } = value as Record<string, unknown>;
    return typeof path === "string" && path.length > 0 && path.length <= 4096 &&
      typeof alt === "string" && alt.trim().length > 0 && alt.length <= 200 ? [{ path, alt }] : [];
  });
}

/** Use the same CommonMark AST as the renderer, including references, escaping and code blocks. */
function presentedPaths(text: string): Set<string> {
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  type Node = { type: string; url?: string; identifier?: string; children?: Node[] };
  const walk = (node: Node, visit: (node: Node) => void) => {
    const stack = [node];
    while (stack.length) {
      const next = stack.pop()!;
      visit(next);
      const children = next.children ?? [];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }
  };
  walk(tree, (node) => {
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  });
  const paths = new Set<string>();
  walk(tree, (node) => {
    const destination = node.type === "image" ? node.url : node.type === "imageReference"
      ? definitions.get(node.identifier ?? "") : undefined;
    if (!destination) return;
    try { paths.add(decodeURIComponent(destination).replace(/\\/g, "/")); }
    catch { paths.add(destination.replace(/\\/g, "/")); }
  });
  return paths;
}

/** Native session policy: explicit presentation intent, validated files, deterministic final repair. */
export function registerShowImage(api: ExtensionAPI, options: ShowImageOptions): void {
  let state = { pending: new Map<string, ShownImage>(), hidden: false };
  const reset = () => { state = { pending: new Map(), hidden: false }; };
  const active = () => api.getActiveTools().includes("show_image");
  const remember = (images: ShownImage[]) => {
    if (state.hidden) return;
    for (const image of images) {
      if (state.pending.size < MAX_SHOWN_IMAGES || state.pending.has(image.path)) {
        state.pending.set(image.path, image);
      }
    }
  };
  const updateVisibility = (text: string) => {
    if (HIDE_IMAGES.test(text)) {
      state.hidden = true;
      state.pending.clear();
    } else if (SHOW_IMAGES.test(text)) state.hidden = false;
  };
  const restore = async (branch: readonly unknown[]) => {
    reset();
    for (const entry of branch) {
      const record = entry as { type?: string; message?: Record<string, unknown> };
      if (record.type !== "message" || !record.message) continue;
      const message = record.message;
      if (message.role === "user") {
        reset();
        const content = message.content;
        const text = typeof content === "string" ? content : Array.isArray(content)
          ? content.map((part) => part?.type === "text" ? part.text : "").join("\n") : "";
        updateVisibility(text);
      } else if (message.role === "toolResult" && message.toolName === "show_image" && !message.isError) {
        remember(imagesFromDetails(message.details));
      } else if (message.role === "assistant" && message.stopReason === "stop") {
        state.pending.clear();
      }
    }
    // Branch data alone is not proof of permission or file validity. Re-check only the bounded pending set.
    const restored = state;
    if (!active()) {
      restored.pending.clear();
      return;
    }
    for (const image of restored.pending.values()) {
      try {
        if (!(await options.validate(image.path)).ok) restored.pending.delete(image.path);
      } catch { restored.pending.delete(image.path); }
      if (restored !== state) return;
    }
  };
  api.on("session_start", (_event, ctx) => restore(ctx.sessionManager.getBranch()));
  api.on("session_tree", (_event, ctx) => restore(ctx.sessionManager.getBranch()));
  api.on("input", (event) => {
    if (event.source === "extension") return;
    if (event.streamingBehavior === undefined) reset();
    updateVisibility(event.text);
  });
  api.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${active() ? POLICY : POLICY.split("\n").at(-1)}`,
  }));
  api.on("tool_result", (event) => {
    if (event.toolName === "show_image" && !event.isError && active()) remember(imagesFromDetails(event.details));
  });
  api.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop") return;
    if (state.hidden || !active()) {
      state.pending.clear();
      return;
    }
    if (state.pending.size === 0) return;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const rendered = presentedPaths(text);
    const missing = [...state.pending.values()]
      .filter((image) => !rendered.has(image.path.replace(/\\/g, "/")))
      .map(shownImageMarkdown);
    state.pending.clear();
    if (missing.length === 0) return;
    return { message: { ...message, content: [
      ...message.content,
      { type: "text" as const, text: `\n\n${missing.join("\n\n")}` },
    ] } };
  });

  api.registerTool({
    name: "show_image",
    label: "Show image",
    description: "Validate local images for user presentation and include them in the final reply. Does not read image pixels into model context. Existing local paths only; no remote fetches.",
    promptSnippet: "Present validated local images; the harness prevents omission from the final reply",
    promptGuidelines: ["Use show_image when presenting generated images, renders or requested screenshots. Never publish internal inspection screenshots or images the user explicitly declined."],
    executionMode: "sequential",
    parameters: Type.Object({ images: Type.Array(Type.Object({
      path: Type.String({ minLength: 1, maxLength: 4096 }),
      alt: Type.String({ minLength: 1, maxLength: 200 }),
    }), { minItems: 1, maxItems: MAX_SHOWN_IMAGES }) }),
    async execute(_id, params, signal) {
      const task = state;
      if (!active()) throw new Error("画像表示ツールが無効です。");
      if (task.hidden) throw new Error("ユーザーが画像表示を不要と指定しています。");
      const paths = new Set([...task.pending.keys(), ...params.images.map((image) => image.path)]);
      if (paths.size > MAX_SHOWN_IMAGES) throw new Error(`1回の返信で表示できる画像は${MAX_SHOWN_IMAGES}件までです。`);
      for (const image of params.images) {
        if (!image.alt.trim()) throw new Error("画像の内容が分かる説明文を指定してください。");
        signal?.throwIfAborted();
        const result = await options.validate(image.path);
        if (!result.ok) throw new Error(result.error);
      }
      signal?.throwIfAborted();
      if (task !== state || task.hidden) throw new Error("依頼が変更されたため画像表示を登録できません。");
      return {
        content: [{ type: "text", text: params.images.map(shownImageMarkdown).join("\n\n") }],
        details: { [DETAILS_KEY]: params.images },
      };
    },
  });
}
