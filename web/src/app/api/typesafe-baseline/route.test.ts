import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTypesafeCreditBaseline } from "@/lib/codexbar/providers/typesafe";
import { DELETE, GET, POST } from "./route";

const previousAppData = process.env.APPDATA;
let appData: string;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "leafcode-typesafe-baseline-api-"));
  process.env.APPDATA = appData;
});

afterEach(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  rmSync(appData, { recursive: true, force: true });
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/typesafe-baseline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/typesafe-baseline", () => {
  it("stores a valid USD baseline and exposes no credential data", async () => {
    expect(await GET().json()).toEqual({ baselineUsd: null });

    const response = await POST(request({ baselineUsd: 5 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, baselineUsd: 5 });
    expect(readTypesafeCreditBaseline()).toBe(5);
    expect(await GET().json()).toEqual({ baselineUsd: 5 });
  });

  it("rejects invalid baselines", async () => {
    for (const baselineUsd of [0, -1, 1_000_001, "5", true, null]) {
      const response = await POST(request({ baselineUsd }));
      expect(response.status).toBe(400);
    }
  });

  it("clears the baseline", async () => {
    await POST(request({ baselineUsd: 5 }));
    const response = DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, baselineUsd: null });
    expect(readTypesafeCreditBaseline()).toBeNull();
  });
});
