import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const getSetting = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/lib/pi/web-settings", () => ({ getSetting }));

function request(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/git/commit-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/git/commit-message", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses direct generation when the selected model is supported", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContain("src/app.ts");
      expect(body.messages[1].content).toContain("+added");
      return new Response(JSON.stringify({ choices: [{ message: { content: "追加 app.ts\n" } }] }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({
        directory: "C:\\repo",
        model: { providerID: "llama-server", modelID: "local-model" },
        files: [
          {
            path: "src/app.ts",
            additions: 1,
            deletions: 0,
            hunks: [{ header: "@@", lines: [{ t: "+", text: "added" }] }],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "追加 app.ts", source: "direct" });
  });

  it("keeps the deterministic fallback for unsupported providers", async () => {
    const response = await POST(
      request({
        directory: "C:\\repo",
        model: { providerID: "cursor", modelID: "subscription-model" },
        files: [{ path: "src/app.ts", untracked: false }],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "更新 app.ts" });
  });
});
