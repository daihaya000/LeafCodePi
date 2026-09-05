import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, PATCH } from "./route";

describe("GET/PATCH /api/settings/commit-guard", () => {
  let previousDataDir: string | undefined;
  let data: string;

  beforeEach(() => {
    previousDataDir = process.env.LEAFCODE_PI_DATA_DIR;
    data = mkdtempSync(join(tmpdir(), "leafcode-commit-guard-api-"));
    process.env.LEAFCODE_PI_DATA_DIR = data;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.LEAFCODE_PI_DATA_DIR;
    else process.env.LEAFCODE_PI_DATA_DIR = previousDataDir;
    rmSync(data, { recursive: true, force: true });
  });

  it("returns the default enabled flag", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: true });
  });

  it("updates the feature flag", async () => {
    const req = new NextRequest("http://localhost/api/settings/commit-guard", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: false });

    const again = await GET();
    await expect(again.json()).resolves.toEqual({ enabled: false });
  });

  it("rejects non-boolean enabled", async () => {
    const req = new NextRequest("http://localhost/api/settings/commit-guard", {
      method: "PATCH",
      body: JSON.stringify({ enabled: "no" }),
      headers: { "content-type": "application/json" },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });
});
