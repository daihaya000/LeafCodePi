import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_AGENTS_MD_BYTES } from "@/lib/agents-md";
import { GET, PATCH } from "./route";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "leafcode-workflow-route-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const request = (body: unknown) => new Request("http://localhost/api/workflow-md", { method: "PATCH", body: JSON.stringify(body) });

it("reads missing files and round-trips UTF-8 workflow content without session reload", async () => {
  expect(await (await GET()).json()).toMatchObject({ exists: false, content: "" });
  const content = "# 検証・コミット\n";
  const saved = await PATCH(request({ content }));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ ok: true, content });
  expect(readFileSync(join(dir, "WORKFLOW.md"), "utf8")).toBe(content);
  expect(await (await GET()).json()).toMatchObject({ exists: true, content });
});

it("rejects invalid JSON, non-string content and oversized UTF-8 without overwriting", async () => {
  await PATCH(request({ content: "keep" }));
  expect((await PATCH(new Request("http://localhost/api/workflow-md", { method: "PATCH", body: "{" }))).status).toBe(400);
  for (const body of [null, [], {}, { content: 1 }]) expect((await PATCH(request(body))).status).toBe(400);
  expect((await PATCH(request({ content: "あ".repeat(Math.ceil(MAX_AGENTS_MD_BYTES / 3)) }))).status).toBe(413);
  expect(readFileSync(join(dir, "WORKFLOW.md"), "utf8")).toBe("keep");
});
