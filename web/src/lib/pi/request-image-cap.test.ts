import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxModelDefinition,
  type FauxResponseStep,
  type ImageContent,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRequestImageLimitsForTests,
  capRequestImages,
  isImageCountError,
  learnRequestImageLimit,
  LIMIT_LEARNED_NOTE,
  MAX_AUTO_RETRIES,
  OMITTED_IMAGE_TEXT,
  parseImageLimitError,
  registerRequestImageCap,
  requestImageLimit,
} from "./request-image-cap";

/** The 2026-09-29 failure after a Claude/GPT session switched to DeepSeek V4.1 Flash on OpenCode Go. */
const REPORTED_ERROR =
  '400: {"param":null,"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] Too many images in request: 54 > 30"}';
const REPORTED_GO_ERROR =
  '400: {"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] a request may include at most 20 images"}';
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
    // 5 images, limit 3: the cut moves in blocks of 1 below a limit of 10.
    const capped = capRequestImages(messages, 3);
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

  it("sends at least 80% of the limit and moves the cut in blocks between requests", () => {
    const omitted = (total: number, limit: number) => {
      const messages: Message[] = Array.from({ length: total }, (_, index) => ({
        role: "toolResult",
        content: [image(String(index))],
      }));
      return total - imageData(capRequestImages(messages, limit)).length;
    };
    expect(omitted(30, 30)).toBe(0);
    expect(omitted(31, 30)).toBe(6);
    expect(omitted(36, 30)).toBe(6);
    expect(omitted(37, 30)).toBe(12);
    // Both reported Go limits must leave no more images than the route accepts.
    expect(omitted(54, 30)).toBe(24);
    expect(omitted(78, 20)).toBe(60);
    for (const limit of [1, 4, 20, 30, 100]) {
      for (let total = limit + 1; total <= limit * 4; total++) {
        const kept = total - omitted(total, limit);
        expect(kept).toBeGreaterThanOrEqual(Math.ceil(limit * 0.8));
        expect(kept).toBeLessThanOrEqual(limit);
      }
    }
  });
});

describe("image-count errors", () => {
  it.each([
    [REPORTED_ERROR, 30],
    [REPORTED_GO_ERROR, 20],
    ["Too many images provided. This model supports up to 5 images", 5],
    ["Too many images in request. Maximum is 100.", 100],
    ["Too many images in request. Max is 20.", 20],
    ["Too many images in request: 20, maximum allowed: 10.", 10],
    ["too many images and documents: 21 + 0 > 20", 20],
    ["At most 30 image(s) may be provided in one prompt.", 30],
    ["Maximum 600 images per request exceeded", 600],
    ["Too many images: 3,500 > 3,000", 3000],
    ["Too many images. Up to 3,000 images are allowed", 3000],
    ["The number of images in the request exceeds the maximum allowed (3000).", 3000],
    ["Too many image parts in the request: 3,001 > 3,000", 3000],
  ])("reads the limit from %s", (message, limit) => {
    expect(isImageCountError(message)).toBe(true);
    expect(parseImageLimitError(message)).toBe(limit);
  });

  it("recognizes an image-count error that states no limit", () => {
    expect(isImageCountError("Too many images")).toBe(true);
    expect(parseImageLimitError("Too many images")).toBeUndefined();
    expect(parseImageLimitError("Too many images; limit exceeded (see docs v2)")).toBeUndefined();
  });

  it.each([
    "image exceeds 5 MB maximum: 5242880 bytes > 5242880 bytes",
    "messages.3.content.1.image.source: image dimensions exceed max allowed size for many-image requests: 2000 pixels",
    "429 Too many requests",
    "prompt is too long: 213462 tokens > 200000 maximum",
    '413: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}',
    "The number of image tokens (5000) exceeds the limit (4096)",
  ])("ignores %s", (message) => {
    expect(isImageCountError(message)).toBe(false);
    expect(parseImageLimitError(message)).toBeUndefined();
  });
});

describe("requestImageLimit", () => {
  it.each([
    [{ provider: "anthropic", id: "claude-haiku-4-5", contextWindow: 200_000 }, 100],
    [{ provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 }, 600],
    [{ provider: "openrouter", id: "anthropic/claude-sonnet-4", contextWindow: 200_000 }, 100],
    [{ provider: "amazon-bedrock", api: "bedrock-converse-stream", id: "anthropic.claude-opus-5", contextWindow: 1_000_000 }, 20],
    [{ provider: "openai-codex", id: "gpt-6-luna" }, 1_500],
    [{ provider: "openrouter", id: "~openai/gpt-luna-latest" }, 1_500],
    [{ provider: "openai", id: "o4-mini" }, 1_500],
    [{ provider: "opencode", id: "gemini-3.7-flash" }, 3_000],
    [{ provider: "deepseek", id: "deepseek-v4.1-flash" }, 600],
    [{ provider: "opencode", id: "deepseek-v4.1-flash" }, 600],
    [{ provider: "opencode-go", id: "deepseek-v4.1-flash" }, 20],
  ])("knows the limit of %o", (model, limit) => {
    expect(requestImageLimit(model)).toBe(limit);
  });

  it("does not cap models without a known limit", () => {
    expect(requestImageLimit(undefined)).toBeUndefined();
    expect(requestImageLimit({ provider: "opencode-go", id: "kimi-k3" })).toBeUndefined();
    expect(requestImageLimit({ provider: "llama", id: "qwen3.8-27b" })).toBeUndefined();
    expect(requestImageLimit({ provider: "openrouter", id: "google/gemma-4-31b" })).toBeUndefined();
  });

  it("prefers a declared maxPerRequest", () => {
    const declared = (maxPerRequest: number) => ({
      provider: "p",
      id: "claude-opus-5-5",
      contextWindow: 1_000_000,
      inputLimits: { images: { maxPerRequest } },
    });
    expect(requestImageLimit(declared(8))).toBe(8);
    expect(requestImageLimit(declared(0))).toBe(600);
    expect(requestImageLimit({ provider: "p", id: "m", inputLimits: { images: { maxPerRequest: 12 } } })).toBe(12);
  });

  it("only tightens the limit of the model the provider error named", () => {
    const route = (provider: string) => ({ provider, id: "deepseek-v4.1-flash" });
    expect(learnRequestImageLimit("opencode", "deepseek-v4.1-flash", REPORTED_ERROR, 54)).toBe(30);
    expect(requestImageLimit(route("opencode"))).toBe(30);
    expect(requestImageLimit(route("deepseek"))).toBe(600);
    expect(learnRequestImageLimit("opencode", "deepseek-v4.1-flash", "Too many images: 60 > 50", 60)).toBeUndefined();
    expect(learnRequestImageLimit("opencode", "deepseek-v4.1-flash", "Too many images: 12 > 10", 12)).toBe(10);
    expect(requestImageLimit(route("opencode"))).toBe(10);
    expect(learnRequestImageLimit("p", "unknown", "Too many images: 12 > 10", 12)).toBe(10);
    expect(requestImageLimit({ provider: "p", id: "unknown" })).toBe(10);
    expect(learnRequestImageLimit("opencode", "deepseek-v4.1-flash", "429 rate limit", 12)).toBeUndefined();
    expect(learnRequestImageLimit(undefined, "deepseek-v4.1-flash", REPORTED_ERROR, 54)).toBeUndefined();
  });

  it("halves the rejected request when the error states no limit", () => {
    expect(learnRequestImageLimit("p", "m", "Too many images", 12)).toBe(6);
    expect(requestImageLimit({ provider: "p", id: "m" })).toBe(6);
    expect(learnRequestImageLimit("p", "m", "Too many images", 1)).toBeUndefined();
    expect(learnRequestImageLimit("p", "other", "Too many images", 0)).toBeUndefined();
  });
});

describe("registerRequestImageCap", () => {
  it("leaves text-only models to pi-ai's own placeholders", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerRequestImageCap({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    const messages: Message[] = [{ role: "user", content: Array.from({ length: 40 }, () => image(PNG)) }];
    const context = (model: object) =>
      handlers.get("context_with_system")!({ type: "context_with_system", messages }, { model });
    const limited = { provider: "p", id: "m", inputLimits: { images: { maxPerRequest: 20 } } };
    expect(context({ ...limited, input: ["text"] })).toBeUndefined();
    expect(imageData((context({ ...limited, input: ["text", "image"] }) as { messages: Message[] }).messages)).toHaveLength(20);
    expect(context({ provider: "p", id: "m", input: ["text", "image"] })).toBeUndefined();
  });

  describe("in a real SDK session", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "leafcode-image-cap-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    async function createSession(responses: FauxResponseStep[], model: Partial<FauxModelDefinition> = {}) {
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
      const faux = fauxProvider({ models: [{ id: "vision", input: ["text", "image"], ...model }] });
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

    /** Each provider request's image count, then the scripted outcome. */
    function recordRequests(sent: number[], outcomes: (string | Error)[]): FauxResponseStep[] {
      return outcomes.map((outcome) => (context) => {
        sent.push(imageData(context.messages).length);
        if (outcome instanceof Error) throw outcome;
        return fauxAssistantMessage(outcome);
      });
    }

    const errors = (session: AgentSession) =>
      session.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
          ? [entry.message.errorMessage ?? ""]
          : [],
      );

    it("sends at most the model's limit while the history keeps every image", async () => {
      const sent: number[] = [];
      const roles: string[] = [];
      const session = await createSession(
        [
          (context) => {
            sent.push(imageData(context.messages).length);
            roles.push(...context.messages.map((message) => message.role));
            return fauxAssistantMessage("seen");
          },
        ],
        { inputLimits: { images: { maxPerRequest: 20 } } },
      );
      try {
        await session.prompt("compare", { images: pngs(40) });
        expect(sent).toEqual([20]);
        // The prompt and tool declarations still lead the request.
        expect(roles[0]).toBe("system");
        expect(imageData(session.messages)).toHaveLength(40);
      } finally {
        session.dispose();
      }
    });

    it("sends every image to a model without a known limit", async () => {
      const sent: number[] = [];
      const session = await createSession(recordRequests(sent, ["seen"]));
      try {
        await session.prompt("compare", { images: pngs(40) });
        expect(sent).toEqual([40]);
      } finally {
        session.dispose();
      }
    });

    it("resends the rejected request within the limit the provider reported", async () => {
      const sent: number[] = [];
      const session = await createSession(
        recordRequests(sent, [new Error("400: Too many images in request: 12 > 10"), "seen", "again"]),
      );
      try {
        await session.prompt("compare", { images: pngs(12) });
        expect(sent).toEqual([12, 10]);
        expect(session.agent.state.errorMessage).toBeUndefined();
        const last = session.messages.at(-1) as { role: string; stopReason?: string };
        expect(last).toMatchObject({ role: "assistant", stopReason: "stop" });
        // The rejection stays in the transcript, explained, but leaves the model context.
        expect(errors(session)).toEqual([`400: Too many images in request: 12 > 10\n${LIMIT_LEARNED_NOTE}`]);
        expect(session.messages.some((message) => (message as { stopReason?: string }).stopReason === "error")).toBe(false);
        await session.prompt("again");
        expect(sent).toEqual([12, 10, 10]);
      } finally {
        session.dispose();
      }
    });

    it("resends when Go says a request may include at most 20 images", async () => {
      const sent: number[] = [];
      const session = await createSession(
        recordRequests(sent, [new Error(REPORTED_GO_ERROR), "seen"]),
        { inputLimits: { images: { maxPerRequest: 30 } } },
      );
      try {
        await session.prompt("resume", { images: pngs(30) });
        // The cache-friendly cut drops two additional old images in a four-image block.
        expect(sent).toEqual([30, 18]);
        expect(session.agent.state.errorMessage).toBeUndefined();
        expect(errors(session)).toEqual([`${REPORTED_GO_ERROR}\n${LIMIT_LEARNED_NOTE}`]);
      } finally {
        session.dispose();
      }
    });

    it("does not resend when the reported limit would not trim the request", async () => {
      const sent: number[] = [];
      const session = await createSession(
        recordRequests(sent, [new Error("400: Too many images in request: 12 > 10"), "unused"]),
      );
      try {
        await session.prompt("compare", { images: pngs(5) });
        expect(sent).toEqual([5]);
        expect(session.agent.state.errorMessage).toContain("Too many images");
      } finally {
        session.dispose();
      }
    });

    it("halves an unstated limit and stops after the retry budget", async () => {
      const sent: number[] = [];
      const session = await createSession(
        recordRequests(sent, [...Array.from({ length: MAX_AUTO_RETRIES + 1 }, () => new Error("Too many images")), "unused"]),
      );
      try {
        await session.prompt("compare", { images: pngs(40) });
        // The fourth rejection would halve again to 2, but the budget is spent.
        expect(sent).toEqual([40, 20, 10, 5]);
        expect(session.agent.state.errorMessage).toContain("Too many images");
      } finally {
        session.dispose();
      }
    });
  });
});
