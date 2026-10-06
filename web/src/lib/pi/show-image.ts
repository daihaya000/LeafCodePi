import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fromMarkdown } from "mdast-util-from-markdown";

export const MAX_SHOWN_IMAGES = 8;
function visibilityPatterns(names: string, english: string) {
  const kinds = "画像|スクリーンショット|レンダー|動画|映像|ビデオ|音声|音楽|オーディオ|メディア";
  const topic = `(?:${names})(?:[/・、と](?:${kinds})){0,4}(?:(?!${kinds}|[。.!?！？;,、\\r\\n]).){0,12}`;
  return {
    hide: new RegExp(`${topic}(?:(?:表示|再生).{0,2}(?:不要|しない)|見せない|聞かせない|貼らない|埋め込まない|不要)|(?:do not|don't|no need to)\\s+(?:show|display|embed|play)\\s+(?:the\\s+)?(?:${english})\\b`, "i"),
    show: new RegExp(`${topic}(?:表示して|見せて|聞かせて|再生して|貼って)|(?:show|display|embed|play)\\s+(?:the\\s+)?(?:${english})\\b`, "i"),
  };
}
const IMAGE_VISIBILITY = visibilityPatterns("画像|スクリーンショット|レンダー", "images?");

export type ShownImage = { path: string; alt: string };
export type ImageValidation = { ok: true } | { ok: false; error: string };
export type ShowImageOptions = {
  /** Uses the task image/media endpoint's validator; this tool never grants filesystem access. */
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

function imagesFromDetails(details: unknown, detailsKey: string): ShownImage[] {
  if (!details || typeof details !== "object") return [];
  const values = (details as Record<string, unknown>)[detailsKey];
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

type PresentationConfig = {
  name: string; field: string; detailsKey: string; noun: string; label: string;
  policy: string; hide: RegExp; show: RegExp;
};

export function registerShowImage(api: ExtensionAPI, options: ShowImageOptions): void {
  registerPresentation(api, options, {
    name: "show_image", field: "images", detailsKey: "shownImages", noun: "画像", label: "Show image",
    policy: POLICY, ...IMAGE_VISIBILITY,
  });
}
function mediaConfig(kind: "video" | "audio"): PresentationConfig {
  const noun = kind === "video" ? "動画" : "音声";
  const names = kind === "video" ? "動画|映像|ビデオ" : "音声|音楽|オーディオ";
  const name = `show_${kind}`;
  return {
    name, field: kind === "video" ? "videos" : "audio", detailsKey: kind === "video" ? "shownVideos" : "shownAudio",
    noun, label: `Show ${kind}`,
    ...visibilityPatterns(`${names}|メディア`, kind === "video" ? "videos?|media" : "audio|sound|music|media"),
    policy: [
      `When presenting generated or requested ${kind}, call ${name} with existing local paths and descriptive alt text. The harness inserts validated media into the final reply if omitted, independently of skill discovery.`,
      `Never publish internal inspection files or media the user declined. ${noun}表示不要 applies to ${kind}, not other media kinds. This tool does not analyze or transcribe media.`,
      `Without ${name}, use ![description](<local media path>) explicitly. WebUI renders supported video/audio destinations as players without autoplay. ${kind === "video" ? "MP4/M4V/MOV/WebM" : "MP3/WAV/M4A/AAC/OGG/Opus/FLAC/WebA"} up to 512 MB; browser codec support varies. No network paths. Remote media open only on user click; never put secrets in URLs. Keep displayed files in place.`,
    ].join("\n"),
  };
}
export function registerShowVideo(api: ExtensionAPI, options: ShowImageOptions): void {
  registerPresentation(api, options, mediaConfig("video"));
}
export function registerShowAudio(api: ExtensionAPI, options: ShowImageOptions): void {
  registerPresentation(api, options, mediaConfig("audio"));
}

/** Shared native policy: explicit intent, validated files, deterministic final repair per media kind. */
function registerPresentation(api: ExtensionAPI, options: ShowImageOptions, config: PresentationConfig): void {
  let state = { pending: new Map<string, ShownImage>(), hidden: false };
  const reset = () => { state = { pending: new Map(), hidden: false }; };
  const active = () => api.getActiveTools().includes(config.name);
  const remember = (images: ShownImage[]) => {
    if (state.hidden) return;
    for (const image of images) {
      if (state.pending.size < MAX_SHOWN_IMAGES || state.pending.has(image.path)) {
        state.pending.set(image.path, image);
      }
    }
  };
  const updateVisibility = (text: string) => {
    if (config.hide.test(text)) {
      state.hidden = true;
      state.pending.clear();
    } else if (config.show.test(text)) state.hidden = false;
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
      } else if (message.role === "toolResult" && message.toolName === config.name && !message.isError) {
        remember(imagesFromDetails(message.details, config.detailsKey));
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
    systemPrompt: `${event.systemPrompt}\n\n${active() ? config.policy : config.policy.split("\n").at(-1)}`,
  }));
  api.on("tool_result", (event) => {
    if (event.toolName === config.name && !event.isError && active()) remember(imagesFromDetails(event.details, config.detailsKey));
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
    name: config.name,
    label: config.label,
    description: `Validate local ${config.label.slice(5)} files for user presentation and include them in the final reply. Does not read media into model context. Existing local paths only; no remote fetches.`,
    promptSnippet: `Present validated local ${config.label.slice(5)} files; the harness prevents omission from the final reply`,
    promptGuidelines: [`Use ${config.name} when presenting generated or requested ${config.noun}. Never publish internal inspection files or media the user explicitly declined.`],
    executionMode: "sequential",
    parameters: Type.Object({ [config.field]: Type.Array(Type.Object({
      path: Type.String({ minLength: 1, maxLength: 4096 }),
      alt: Type.String({ minLength: 1, maxLength: 200 }),
    }), { minItems: 1, maxItems: MAX_SHOWN_IMAGES }) }),
    async execute(_id, params, signal) {
      const task = state;
      if (!active()) throw new Error(`${config.noun}表示ツールが無効です。`);
      if (task.hidden) throw new Error(`ユーザーが${config.noun}表示を不要と指定しています。`);
      const images = params[config.field];
      const paths = new Set([...task.pending.keys(), ...images.map((image) => image.path)]);
      if (paths.size > MAX_SHOWN_IMAGES) throw new Error(`1回の返信で表示できる${config.noun}は${MAX_SHOWN_IMAGES}件までです。`);
      for (const image of images) {
        if (!image.alt.trim()) throw new Error(`${config.noun}の内容が分かる説明文を指定してください。`);
        signal?.throwIfAborted();
        const result = await options.validate(image.path);
        if (!result.ok) throw new Error(result.error);
      }
      signal?.throwIfAborted();
      if (task !== state || task.hidden || !active()) throw new Error(`依頼が変更されたか権限が失われたため${config.noun}表示を登録できません。`);
      return {
        content: [{ type: "text", text: images.map(shownImageMarkdown).join("\n\n") }],
        details: { [config.detailsKey]: images },
      };
    },
  });
}
