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

  it("defaults to enabled and can disable/enable via PATCH", async () => {
    const initial = await GET();
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { systemSafety: true });

    const disabled = await PATCH(request({ systemSafety: false }));
    assert.equal(disabled.status, 200);
    assert.deepEqual(await disabled.json(), { systemSafety: false });
    assert.equal(
      JSON.parse(readFileSync(join(appDir, "permission-gate.json"), "utf8")).systemSafety,
      false,
    );

    const enabled = await PATCH(request({ systemSafety: true }));
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { systemSafety: true });
  });

  it("rejects non-boolean bodies", async () => {
    const response = await PATCH(request({ systemSafety: "off" }));
    assert.equal(response.status, 400);
  });
});
