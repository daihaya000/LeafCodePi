import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRequestImageLimitsForTests,
  capRequestImages,
  DEFAULT_REQUEST_IMAGE_LIMIT,
  learnRequestImageLimit,
  OMITTED_IMAGE_TEXT,
  parseImageLimitError,
  registerRequestImageCap,
  requestImageLimit,
} from "./request-image-cap";

/** The 2026-09-29 failure after a Claude/GPT session switched to DeepSeek V4.1 Flash. */
const REPORTED_ERROR =
  '400: {"param":null,"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] Too many images in request: 54 > 30"}';
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Message = { role: string; content: string | Block[] };

const image = (data: string): Block => ({ type: "image", data, mimeType: "image/png" });
const text = (value: string): Block => ({ type: "text", text: value });
const pngs = (count: number): ImageContent[] =>
  Array.from({ length: count }, () => ({ type: "image", data: PNG, mimeType: "image/png" }));

function imageData(messages: readonly object[]): string[] {
  return messages.flatMap((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content)
      ? (content as Block[]).filter((block) => block.type === "image").map((block) => block.data ?? "")
      : [];
  });
}

beforeEach(() => {
  __resetRequestImageLimitsForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("capRequestImages", () => {
  it("returns the same messages when the images fit", () => {
    const messages: Message[] = [{ role: "user", content: [text("look"), image("a")] }];
    expect(capRequestImages(messages, 1)).toBe(messages);
  });

  it("replaces the oldest images, keeps the newest and never mutates the input", () => {
    const messages: Message[] = [
      { role: "user", content: [text("look"), image("u1"), image("u2")] },
      { role: "assistant", content: [text("ok")] },
      { role: "toolResult", content: [text("Read image file [image/png]"), image("t1")] },
      { role: "user", content: "plain" },
      { role: "toolResult", content: [image("t2"), image("t3")] },
    ];
    const before = structuredClone(messages);
    // 5 images, limit 4: the cut moves in steps of 2, so 3 remain.
    const capped = capRequestImages(messages, 4);
    expect(imageData(capped)).toEqual(["t1", "t2", "t3"]);
    // Adjacent omitted images share one note.
    expect(capped[0].content).toEqual([text("look"), text(OMITTED_IMAGE_TEXT)]);
    expect(capped.slice(1)).toEqual(messages.slice(1));
    expect(capped[2]).toBe(messages[2]);
    expect(messages).toEqual(before);
  });

  it("keeps only the newest image at a limit of one", () => {
    const messages: Message[] = [{ role: "user", content: [image("a"), image("b"), image("c")] }];
    expect(capRequestImages(messages, 1)[0].content).toEqual([text(OMITTED_IMAGE_TEXT), image("c")]);
  });

  it("moves the cut in steps so the omitted prefix stays stable between requests", () => {
    const omitted = (total: number) => {
      const messages: Message[] = Array.from({ length: total }, (_, index) => ({
        role: "toolResult",
        content: [image(String(index))],
      }));
      return total - imageData(capRequestImages(messages, DEFAULT_REQUEST_IMAGE_LIMIT)).length;
    };
    expect(omitted(30)).toBe(0);
    expect(omitted(31)).toBe(15);
    expect(omitted(45)).toBe(15);
    expect(omitted(46)).toBe(30);
    // The reported request: 24 of 54 images now reach DeepSeek.
    expect(omitted(54)).toBe(30);
    for (let total = 31; total <= 200; total++) {
      const kept = total - omitted(total);
      expect(kept).toBeGreaterThan(DEFAULT_REQUEST_IMAGE_LIMIT / 2);
      expect(kept).toBeLessThanOrEqual(DEFAULT_REQUEST_IMAGE_LIMIT);
    }
  });
});

describe("parseImageLimitError", () => {
  it.each([
    [REPORTED_ERROR, 30],
    ["Too many images provided. This model supports up to 5 images", 5],
    ["Too many images in request. Maximum is 100.", 100],
    ["too many images (54); maximum allowed: 20", 20],
    ["Too many images: 3,500 > 3,000", 3000],
    ["Too many images. Up to 3,000 images are allowed", 3000],
  ])("reads the limit from %s", (message, limit) => {
    expect(parseImageLimitError(message)).toBe(limit);
  });

  it.each([
    "image exceeds 5 MB maximum: 5242880 bytes > 5242880 bytes",
    "Too many images",
    "Too many images; limit exceeded (see docs v2)",
    "429 Too many requests",
  ])("ignores %s", (message) => {
    expect(parseImageLimitError(message)).toBeUndefined();
  });
});

describe("requestImageLimit", () => {
  const declared = (provider: string, maxPerRequest: number) => ({
    provider,
    id: "deepseek-v4.1-flash",
    inputLimits: { images: { maxPerRequest } },
  });

  it("uses the declared maxPerRequest, otherwise the default", () => {
    expect(requestImageLimit(undefined)).toBe(DEFAULT_REQUEST_IMAGE_LIMIT);
    expect(requestImageLimit({ provider: "p", id: "m" })).toBe(DEFAULT_REQUEST_IMAGE_LIMIT);
    expect(requestImageLimit(declared("p", 100))).toBe(100);
    expect(requestImageLimit(declared("p", 0))).toBe(DEFAULT_REQUEST_IMAGE_LIMIT);
  });

  it("only tightens the limit of the model the provider error named", () => {
    expect(learnRequestImageLimit("opencode-go", "deepseek-v4.1-flash", REPORTED_ERROR)).toBe(30);
    expect(requestImageLimit(declared("opencode-go", 100))).toBe(30);
    expect(requestImageLimit(declared("opencode", 100))).toBe(100);
    expect(learnRequestImageLimit("opencode-go", "deepseek-v4.1-flash", "Too many images: 60 > 50")).toBe(30);
    expect(learnRequestImageLimit("opencode-go", "deepseek-v4.1-flash", "Too many images: 12 > 10")).toBe(10);
    expect(requestImageLimit(declared("opencode-go", 100))).toBe(10);
    expect(learnRequestImageLimit("opencode-go", "deepseek-v4.1-flash", "429 rate limit")).toBeUndefined();
    expect(learnRequestImageLimit(undefined, "deepseek-v4.1-flash", REPORTED_ERROR)).toBeUndefined();
  });
});

describe("registerRequestImageCap", () => {
  it("leaves text-only models to pi-ai's own placeholders", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerRequestImageCap({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    const messages: Message[] = [{ role: "user", content: Array.from({ length: 40 }, () => image(PNG)) }];
    const context = (input: string[]) =>
      handlers.get("context_with_system")!(
        { type: "context_with_system", messages },
        { model: { provider: "p", id: "m", input } },
      );
    expect(context(["text"])).toBeUndefined();
    expect(imageData((context(["text", "image"]) as { messages: Message[] }).messages)).toHaveLength(25);
  });

  describe("in a real SDK session", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "leafcode-image-cap-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    async function createSession(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
      const agentDir = join(root, "agent");
      mkdirSync(agentDir, { recursive: true });
      const settingsManager = SettingsManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [registerRequestImageCap as ExtensionFactory],
      });
      await resourceLoader.reload();
      const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
      faux.setResponses(responses);
      const modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const { session } = await createAgentSession({
        cwd: root,
        agentDir,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(root),
        modelRuntime,
        model: faux.getModel(),
        tools: [],
      });
      await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
      return session;
    }

    it("sends at most the default number of images while the history keeps all of them", async () => {
      const sent: number[] = [];
      const roles: string[] = [];
      const session = await createSession([
        (context) => {
          sent.push(imageData(context.messages).length);
          roles.push(...context.messages.map((message) => message.role));
          return fauxAssistantMessage("seen");
        },
      ]);
      try {
        await session.prompt("compare", { images: pngs(40) });
        expect(sent).toEqual([25]);
        // The prompt and tool declarations still lead the request.
        expect(roles[0]).toBe("system");
        expect(imageData(session.messages)).toHaveLength(40);
      } finally {
        session.dispose();
      }
    });

    it("fits the next request after a provider reports a tighter limit", async () => {
      const sent: number[] = [];
      const session = await createSession([
        (context) => {
          sent.push(imageData(context.messages).length);
          throw new Error("400: Too many images in request: 12 > 10");
        },
        (context) => {
          sent.push(imageData(context.messages).length);
          return fauxAssistantMessage("seen");
        },
      ]);
      try {
        await session.prompt("compare", { images: pngs(12) });
        await session.prompt("again");
        // Limit 10 trims in steps of 5.
        expect(sent).toEqual([12, 7]);
      } finally {
        session.dispose();
      }
    });
  });
});
