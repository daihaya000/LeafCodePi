import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { WebSocketServer } from "ws";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { OPENAI_FAST_MODE_SETTING_KEY } from "@/lib/openai-fast-mode";
import { setSetting } from "@/lib/pi/web-settings";
import { sessionExtensionFactories } from "./harness";

let server: Server | undefined;
let sockets: WebSocketServer | undefined;
let root = "";
afterEach(async () => {
  if (sockets) {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets!.close(() => resolve()));
    sockets = undefined;
  }
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function responseEvents(serviceTier: string, index: number) {
  const messageId = `msg_${index}`;
  const response = { id: `resp_${index}`, object: "response", status: "completed", service_tier: serviceTier, output: [
    { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] },
  ], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...response.output[0], content: [], status: "in_progress" } },
    { type: "response.content_part.added", output_index: 0, item_id: messageId, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: messageId, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: response.output[0] },
    { type: "response.completed", response },
  ];
}

it.each([
  { provider: "openai", api: "openai-responses", transport: "sse" },
  { provider: "openai-codex", api: "openai-codex-responses", transport: "sse" },
  { provider: "openai-codex", api: "openai-codex-responses", transport: "websocket" },
  { provider: "openai-codex", api: "openai-codex-responses", transport: "websocket-cached" },
] as const)("sends Fast correctly via $provider/$transport, including Codex default-tier responses", async ({ provider, api, transport }) => {
  root = mkdtempSync(join(tmpdir(), "leafcode-fast-e2e-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  const bodies: Array<Record<string, unknown>> = [];
  const completionTiers: unknown[] = [];
  const failures: string[] = [];
  const observedTransports: string[] = [];
  const accept = (body: Record<string, unknown>) => {
    bodies.push(body);
    // ChatGPT-authenticated Codex reports default even for Fast requests.
    // Official explanation: https://github.com/openai/codex/issues/14204#issuecomment-4033184620
    const tier = provider === "openai-codex" ? "default" : String(body.service_tier ?? "default");
    return responseEvents(tier, bodies.length);
  };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        let bytes: Buffer = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "zstd") {
          // Node 24 SDK compresses Codex SSE requests; older Node falls back to JSON.
          const nativeZlib = zlib as typeof zlib & { zstdDecompressSync(input: Uint8Array): Buffer };
          bytes = nativeZlib.zstdDecompressSync(bytes);
        }
        const events = accept(JSON.parse(bytes.toString("utf8")));
        observedTransports.push("sse");
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } catch (error) {
        failures.push(String(error));
        res.writeHead(400).end();
      }
    });
  });
  sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    sockets!.handleUpgrade(req, socket, head, (client) => {
      client.on("message", (raw) => {
        try {
          const body = JSON.parse(raw.toString());
          const events = accept(body);
          observedTransports.push("websocket");
          for (const event of events) client.send(JSON.stringify(event));
        } catch (error) {
          failures.push(String(error));
          client.close(1002);
        }
      });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const jwtBody = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url");
  modelRuntime.registerProvider(provider, {
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: provider === "openai-codex" ? `test.${jwtBody}.signature` : "test-key", api,
    models: [{ id: "gpt-test", name: "gpt-test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
  });
  const settingsManager = SettingsManager.inMemory({ transport, cacheWarming: "off" });
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [
      ...sessionExtensionFactories({ agentDir, hasBotSkills: false, getExtensions: () => [] }).slice(0, 1),
      (extension) => {
        extension.on("provider_stream_event", (event) => {
          const data = event.data as { type?: string; response?: { service_tier?: unknown } };
          if (data.type === "response.completed") completionTiers.push(data.response?.service_tier);
        });
      },
    ],
  });
  await loader.reload();
  const model = modelRuntime.getModel(provider, "gpt-test")!;
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root),
    modelRuntime, model, tools: [],
  });
  try {
    await session.bindExtensions({ onError: (error) => failures.push(error.error) });
    for (const enabled of [false, true, false]) {
      setSetting(OPENAI_FAST_MODE_SETTING_KEY, enabled ? "1" : null);
      await session.prompt("hello");
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
    }
    expect(failures).toEqual([]);
    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => body.service_tier)).toEqual([undefined, "priority", undefined]);
    const actualTransport = transport === "sse" ? "sse" : "websocket";
    expect(observedTransports).toEqual([actualTransport, actualTransport, actualTransport]);
    expect(completionTiers).toEqual(provider === "openai-codex" ? ["default", "default", "default"] : ["default", "priority", "default"]);
  } finally {
    session.dispose();
  }
}, 20_000);
