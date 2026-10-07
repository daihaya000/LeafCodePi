import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyMarkdownMediaSource, localMediaPathKey } from "@/lib/markdown-media-source";
import { Type } from "typebox";
import { fromMarkdown } from "mdast-util-from-markdown";

export const MAX_SHOWN_IMAGES = 8;
function visibilityPatterns(names: string, english: string) {
  const kinds = "画像|スクリーンショット|レンダー|動画|映像|ビデオ|音声|音楽|オーディオ|メディア";
  const topic = `(?:${names})(?:[/・、と](?:${kinds})){0,4}(?:(?!${kinds}|[。.!?！？;,、\\r\\n]).){0,12}`;
  return {
    hide: new RegExp(`${topic}(?:(?:表示|再生).{0,2}(?:不要|しない)|見せない|聞かせない|貼らない|埋め込まない|不要)|(?:do not|don't|no need to)\\s+(?:show|display|embed|play)\\s+(?:(?:the|any|all)\\s+)?(?:${english})\\b`, "i"),
    show: new RegExp(`${topic}(?:表示して|見せて|聞かせて|再生して|貼って)|(?:show|display|embed|play)\\s+(?:(?:the|any|all)\\s+)?(?:${english})\\b`, "i"),
  };
}
const IMAGE_VISIBILITY = visibilityPatterns("画像|スクリーンショット|レンダー|メディア", "images?|media");

export type ShownImage = { path: string; alt: string };
export type ImageValidation = { ok: true } | { ok: false; error: string };
export type ShowImageOptions = {
  /** Uses the task image/media endpoint's validator; this tool never grants filesystem access. */
  validate: (path: string) => ImageValidation | Promise<ImageValidation>;
};

const POLICY = [
  "Image presentation is handled by the harness, not just the show-media skill.",
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
    const source = classifyMarkdownMediaSource(destination);
    if (source.kind === "local") paths.add(localMediaPathKey(source.path));
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

type PresentationState = { pending: Map<string, ShownImage>; hidden: boolean; requestId: string };
type Registration = { config: PresentationConfig; options: ShowImageOptions; state: PresentationState };
type PresentationEngine = { registrations: Map<string, Registration>; requestId: string };
const INPUT_ENTRY = "leafcode-media-input";
const engines = new WeakMap<ExtensionAPI, PresentationEngine>();
const emptyState = (requestId: string): PresentationState => ({ pending: new Map(), hidden: false, requestId });

/** One event pipeline per API, even when all three presentation tools are registered. */
function createEngine(api: ExtensionAPI): PresentationEngine {
  const engine: PresentationEngine = { registrations: new Map(), requestId: randomUUID() };
  const reset = (id: string = randomUUID()) => {
    engine.requestId = id;
    for (const registration of engine.registrations.values()) registration.state = emptyState(id);
  };
  const visibility = (text: string, only?: (name: string) => boolean) => {
    for (const { config, state } of engine.registrations.values()) {
      if (only && !only(config.name)) continue;
      if (config.hide.test(text)) { state.hidden = true; state.pending.clear(); }
      else if (config.show.test(text)) state.hidden = false;
    }
  };
  const remember = (registration: Registration, details: unknown) => {
    if (registration.state.hidden) return;
    for (const image of imagesFromDetails(details, registration.config.detailsKey)) {
      const key = localMediaPathKey(image.path);
      const pending = registration.state.pending;
      if (pending.size < MAX_SHOWN_IMAGES || pending.has(key)) pending.set(key, image);
    }
  };
  const restore = async (branch: readonly unknown[]) => {
    reset();
    const marked = new Set<string>();
    for (const entry of branch) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { type?: string; customType?: string; data?: Record<string, unknown>; message?: Record<string, unknown> };
      if (record.type === "custom" && record.customType === INPUT_ENTRY) {
        const data = record.data;
        if (!data || typeof data.reset !== "boolean") continue;
        let states: Record<string, unknown>;
        if (data.version === 2 && data.states && typeof data.states === "object" && !Array.isArray(data.states)) {
          states = data.states as Record<string, unknown>;
        } else if (data.version === 1 && typeof data.requestId === "string" && Array.isArray(data.hidden)) {
          // Compatibility with the original single-factory input ledger.
          const hidden = data.hidden;
          states = Object.fromEntries([...engine.registrations.keys()].map((name) =>
            [name, { requestId: data.requestId, hidden: hidden.includes(name) }],
          ));
        } else continue;
        for (const [name, registration] of engine.registrations) {
          if (!Object.hasOwn(states, name)) continue;
          const saved = states[name] as Record<string, unknown> | null;
          if (!saved || typeof saved.requestId !== "string" || !saved.requestId || saved.requestId.length > 128 || typeof saved.hidden !== "boolean") continue;
          marked.add(name);
          if (data.reset) registration.state = emptyState(saved.requestId);
          else registration.state.requestId = saved.requestId;
          registration.state.hidden = saved.hidden;
          if (saved.hidden) registration.state.pending.clear();
        }
        continue;
      }
      if (record.type !== "message" || !record.message) continue;
      const message = record.message;
      if (message.role === "user") {
        // Legacy branches lack input provenance; retain the conservative old task boundary per tool.
        for (const [name, registration] of engine.registrations) {
          if (!marked.has(name)) registration.state = emptyState(randomUUID());
        }
        const content = message.content;
        visibility(typeof content === "string" ? content : Array.isArray(content)
          ? content.map((part) => part?.type === "text" ? part.text : "").join("\n") : "", (name) => !marked.has(name));
      } else if (message.role === "toolResult" && !message.isError) {
        const registration = engine.registrations.get(String(message.toolName));
        const details = message.details as Record<string, unknown> | undefined;
        if (registration && (!marked.has(registration.config.name) || details?.presentationRequestId === registration.state.requestId)) remember(registration, details);
      } else if (message.role === "assistant" && message.stopReason === "stop") {
        for (const { state } of engine.registrations.values()) state.pending.clear();
      }
    }
    const id = engine.requestId;
    const active = new Set(api.getActiveTools());
    // Revalidate only the bounded unfinished registrations, never the entire historical output.
    for (const { config, state, options } of engine.registrations.values()) {
      if (state.hidden || !active.has(config.name)) { state.pending.clear(); continue; }
      for (const [key, image] of state.pending) {
        try { if (!(await options.validate(image.path)).ok) state.pending.delete(key); }
        catch { state.pending.delete(key); }
        if (id !== engine.requestId) return;
      }
    }
  };
  api.on("session_start", (_event, ctx) => restore(ctx.sessionManager.getBranch()));
  api.on("session_tree", (_event, ctx) => restore(ctx.sessionManager.getBranch()));
  api.on("input", (event) => {
    if (event.source === "extension") return;
    const newRequest = event.streamingBehavior === undefined;
    if (newRequest) reset();
    visibility(event.text);
    // Persist input intent, not the user text. Streaming/extension provenance is absent in UserMessage.
    api.appendEntry?.(INPUT_ENTRY, {
      version: 2, reset: newRequest,
      states: Object.fromEntries([...engine.registrations].map(([name, { state }]) =>
        [name, { requestId: state.requestId, hidden: state.hidden }],
      )),
    });
  });
  api.on("before_agent_start", (event) => {
    const active = new Set(api.getActiveTools());
    const policies = [...engine.registrations.values()].map(({ config }) =>
      active.has(config.name) ? config.policy : config.policy.split("\n").at(-1),
    );
    return { systemPrompt: [event.systemPrompt, ...policies].join("\n\n") };
  });
  api.on("tool_result", (event) => {
    const registration = engine.registrations.get(event.toolName);
    const details = event.details as Record<string, unknown> | undefined;
    if (registration && !event.isError && api.getActiveTools().includes(event.toolName) &&
        details?.presentationRequestId === registration.state.requestId) remember(registration, details);
  });
  api.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "stop") return;
    const active = new Set(api.getActiveTools());
    const pending: ShownImage[] = [];
    for (const { config, state } of engine.registrations.values()) {
      if (!state.hidden && active.has(config.name)) pending.push(...state.pending.values());
      state.pending.clear();
    }
    if (!pending.length) return;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    // All media kinds share one AST parse and one final replacement.
    const rendered = presentedPaths(text);
    const missing = pending.filter((image) => !rendered.has(localMediaPathKey(image.path))).map(shownImageMarkdown);
    if (!missing.length) return;
    return { message: { ...message, content: [
      ...message.content, { type: "text" as const, text: "\n\n" + missing.join("\n\n") },
    ] } };
  });
  return engine;
}

function registerPresentation(api: ExtensionAPI, options: ShowImageOptions, config: PresentationConfig): void {
  let engine = engines.get(api);
  if (!engine) { engine = createEngine(api); engines.set(api, engine); }
  const current = engine;
  const registration: Registration = { config, options, state: emptyState(current.requestId) };
  current.registrations.set(config.name, registration);
  api.registerTool({
    name: config.name, label: config.label,
    description: `Validate local ${config.label.slice(5)} files for user presentation and include them in the final reply. Does not read media into model context. Existing local paths only; no remote fetches.`,
    promptSnippet: `Present validated local ${config.label.slice(5)} files; the harness prevents omission from the final reply`,
    promptGuidelines: [`Use ${config.name} when presenting generated or requested ${config.noun}. Never publish internal inspection files or media the user explicitly declined.`],
    executionMode: "sequential",
    parameters: Type.Object({ [config.field]: Type.Array(Type.Object({
      path: Type.String({ minLength: 1, maxLength: 4096 }),
      alt: Type.String({ minLength: 1, maxLength: 200 }),
    }), { minItems: 1, maxItems: MAX_SHOWN_IMAGES }) }),
    async execute(_id, params, signal) {
      const task = registration.state;
      const requestId = task.requestId;
      if (!api.getActiveTools().includes(config.name)) throw new Error(`${config.noun}表示ツールが無効です。`);
      if (task.hidden) throw new Error(`ユーザーが${config.noun}表示を不要と指定しています。`);
      const unique = new Map(params[config.field].map((image) => [localMediaPathKey(image.path), { path: image.path, alt: image.alt }]));
      const images = [...unique.values()];
      const paths = new Set([...task.pending.keys(), ...unique.keys()]);
      if (paths.size > MAX_SHOWN_IMAGES) throw new Error(`1回の返信で表示できる${config.noun}は${MAX_SHOWN_IMAGES}件までです。`);
      for (const image of images) {
        if (!image.alt.trim()) throw new Error(`${config.noun}の内容が分かる説明文を指定してください。`);
        signal?.throwIfAborted();
        const result = await options.validate(image.path);
        if (!result.ok) throw new Error(result.error);
      }
      signal?.throwIfAborted();
      if (requestId !== registration.state.requestId || task !== registration.state || task.hidden || !api.getActiveTools().includes(config.name)) {
        throw new Error(`依頼が変更されたか権限が失われたため${config.noun}表示を登録できません。`);
      }
      return {
        content: [{ type: "text", text: images.map(shownImageMarkdown).join("\n\n") }],
        details: { [config.detailsKey]: images, presentationRequestId: requestId },
      };
    },
  });
}
