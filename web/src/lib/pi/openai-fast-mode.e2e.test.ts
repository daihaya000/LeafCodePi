import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { OPENAI_FAST_MODE_SETTING_KEY } from "@/lib/openai-fast-mode";
import { setSetting } from "@/lib/pi/web-settings";
import { sessionExtensionFactories } from "./harness";

let server: Server | undefined;
let root = "";
afterEach(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function sse(res: import("node:http").ServerResponse, serviceTier: string) {
  const response = { id: "resp_1", object: "response", status: "completed", service_tier: serviceTier, output: [
    { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] },
  ], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...response.output[0], content: [], status: "in_progress" } },
    { type: "response.content_part.added", output_index: 0, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: response.output[0] },
    { type: "response.completed", response },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

it("sends service_tier=priority to the OpenAI Responses endpoint only while Fast mode is on", async () => {
  root = mkdtempSync(join(tmpdir(), "leafcode-fast-e2e-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  const bodies: Array<Record<string, unknown>> = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      sse(res, String(body.service_tier ?? "default"));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("openai", {
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "test-key", api: "openai-responses",
    models: [{ id: "gpt-test", name: "gpt-test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: sessionExtensionFactories({ agentDir, hasBotSkills: false, getExtensions: () => [] }),
  });
  await loader.reload();
  const model = modelRuntime.getModel("openai", "gpt-test")!;
  const { session } = await createAgentSession({
    cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root),
    modelRuntime, model, tools: [],
  });
  try {
    await session.bindExtensions({});
    await session.prompt("hello");
    setSetting(OPENAI_FAST_MODE_SETTING_KEY, "1");
    await session.prompt("hello again");
    setSetting(OPENAI_FAST_MODE_SETTING_KEY, null);
    await session.prompt("third");
    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => body.service_tier)).toEqual([undefined, "priority", undefined]);
  } finally {
    session.dispose();
  }
}, 25_000);
