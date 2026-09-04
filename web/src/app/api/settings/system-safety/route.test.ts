import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, it } from "vitest";
import { GET, PATCH } from "./route";

function request(body?: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:3010/api/settings/system-safety", {
    method: body === undefined ? "GET" : "PATCH",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/settings/system-safety", () => {
  let appDir = "";
  let previous: string | undefined;

  beforeEach(() => {
    appDir = mkdtempSync(join(tmpdir(), "lcp-system-safety-api-"));
    previous = process.env.LEAFCODE_PI_DATA_DIR;
    process.env.LEAFCODE_PI_DATA_DIR = appDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previous;
    rmSync(appDir, { recursive: true, force: true });
  });

  it("defaults to strict and can change levels via PATCH", async () => {
    const initial = await GET();
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { level: "strict", systemSafety: true });

    const low = await PATCH(request({ level: "low" }));
    assert.equal(low.status, 200);
    assert.deepEqual(await low.json(), { level: "low", systemSafety: true });
    assert.equal(
      JSON.parse(readFileSync(join(appDir, "permission-gate.json"), "utf8")).systemSafety,
      "low",
    );

    const off = await PATCH(request({ systemSafety: false }));
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { level: "off", systemSafety: false });
  });

  it("rejects invalid bodies", async () => {
    const response = await PATCH(request({ level: "medium" }));
    assert.equal(response.status, 400);
  });
});
