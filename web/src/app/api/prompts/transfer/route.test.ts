import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/pi/harness", () => ({ reloadLiveSessionsContext: vi.fn(async () => ({ reloaded: 0, failed: 0, errors: [] })) }));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "leafcode-prompts-route-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("LEAFCODE_PI_DATA_DIR", join(root, "data"));
  vi.stubEnv("LEAFCODE_PI_BIND_HOST", "127.0.0.1");
  mkdirSync(join(root, "agent"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const request = (body: unknown, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/prompts/transfer", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

it("exports existing prompts and imports only the selected file", async () => {
  writeFileSync(join(root, "agent", "USER.md"), "old user");
  writeFileSync(join(root, "agent", "SOUL.md"), "old soul");
  const exported = await POST(request({ action: "export" }));
  expect(exported.status).toBe(200);
  expect(exported.headers.get("cache-control")).toContain("no-store");
  const { backup } = await exported.json();
  expect(Object.keys(backup.files)).toEqual(["USER.md", "SOUL.md"]);
  writeFileSync(join(root, "agent", "USER.md"), "new user");
  writeFileSync(join(root, "agent", "SOUL.md"), "new soul");
  const imported = await POST(request({ action: "import", backup, selected: ["USER.md"] }));
  expect(imported.status).toBe(200);
  expect((await imported.json()).imported).toEqual(["USER.md"]);
  expect(readFileSync(join(root, "agent", "USER.md"), "utf8")).toBe("old user");
  expect(readFileSync(join(root, "agent", "SOUL.md"), "utf8")).toBe("new soul");
});

it("rejects cross-origin, unauthenticated remote access and malicious selected names", async () => {
  writeFileSync(join(root, "agent", "USER.md"), "keep");
  expect((await POST(request({ action: "export" }, { origin: "https://evil.example" }))).status).toBe(403);
  vi.stubEnv("LEAFCODE_PI_BIND_HOST", "100.127.32.3");
  vi.stubEnv("LEAFCODE_PI_WEBUI_AUTH", "required");
  vi.stubEnv("LEAFCODE_PI_WEBUI_TOKEN", "test-token");
  expect((await POST(request({ action: "export" }))).status).toBe(403);
  vi.stubEnv("LEAFCODE_PI_BIND_HOST", "127.0.0.1");
  const backup = { format: "leafcode-pi-prompts", version: 1, exportedAt: new Date().toISOString(), files: { "USER.md": "changed" } };
  expect((await POST(request({ action: "import", backup, selected: ["../auth.json"] }))).status).toBe(400);
  expect((await POST(new NextRequest("http://localhost/api/prompts/transfer", { method: "POST", body: "{" }))).status).toBe(400);
  expect(readFileSync(join(root, "agent", "USER.md"), "utf8")).toBe("keep");
});
