import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ENABLED,
  parseEnabledProviders,
  ProviderConfigError,
  resolveEnabledProviderIds,
  versionOf,
} from "@/lib/codexbar/provider-catalog";
import { GET, PUT } from "./route";

function request(body: unknown): Request {
  return new Request("http://localhost/api/codexbar/providers", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

const originalAppData = process.env.APPDATA;
let appData: string;

beforeEach(async () => {
  appData = await fs.mkdtemp(path.join(os.tmpdir(), "codexbar-providers-"));
  process.env.APPDATA = appData;
  await fs.mkdir(path.join(appData, "CodexBar"));
  await fs.writeFile(
    path.join(appData, "CodexBar", "config.json"),
    JSON.stringify({
      enabledProviders: ["codex", "claude", "codex"],
      syntheticApiKey: "not-returned",
    }),
  );
});

afterEach(async () => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  await fs.rm(appData, { recursive: true, force: true });
});

describe("parseEnabledProviders / resolveEnabledProviderIds", () => {
  it("defaults when key is missing", () => {
    expect(parseEnabledProviders({})).toEqual(DEFAULT_ENABLED);
  });

  it("throws on invalid array for API-style parse", () => {
    expect(() => parseEnabledProviders({ enabledProviders: ["nope"] })).toThrow(
      ProviderConfigError,
    );
  });

  it("resolveEnabledProviderIds defaults when no config file", async () => {
    await fs.rm(path.join(appData, "CodexBar", "config.json"), { force: true });
    expect(resolveEnabledProviderIds()).toEqual(DEFAULT_ENABLED);
  });

  it("resolveEnabledProviderIds soft-defaults on invalid enabledProviders", async () => {
    await fs.writeFile(
      path.join(appData, "CodexBar", "config.json"),
      JSON.stringify({ enabledProviders: ["bogus"] }),
    );
    expect(resolveEnabledProviderIds()).toEqual(DEFAULT_ENABLED);
  });
});

describe("CodexBar provider settings API", () => {
  it("returns only a fixed safe catalog and a version", async () => {
    const response = await GET();
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: "codex",
          name: "Codex",
          enabled: true,
          configurable: true,
        }),
        expect.objectContaining({ id: "claude", enabled: true }),
        expect.objectContaining({ id: "synthetic", enabled: false }),
      ]),
      version: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("not-returned");
  });

  it("returns defaults with version of '{}' when config is missing", async () => {
    await fs.rm(path.join(appData, "CodexBar", "config.json"), { force: true });
    const response = await GET();
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.version).toBe(versionOf("{}"));
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", enabled: true }),
        expect.objectContaining({ id: "claude", enabled: true }),
        expect.objectContaining({ id: "cursor", enabled: true }),
        expect.objectContaining({ id: "synthetic", enabled: false }),
      ]),
    );
  });

  it("accepts OpenRouter in the native enabledProviders setting", async () => {
    await fs.writeFile(
      path.join(appData, "CodexBar", "config.json"),
      JSON.stringify({ enabledProviders: ["codex", "openrouter"] }),
    );

    const response = await GET();
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openrouter",
          name: "OpenRouter",
          enabled: true,
          configurable: true,
        }),
      ]),
    );
  });

  it("deduplicates enabledProviders, preserves unrelated config, and rejects stale writes", async () => {
    const initial = await responseJson(await GET());
    const updatedResponse = await PUT(
      request({
        providerId: "claude",
        enabled: false,
        version: initial.version,
      }),
    );
    const updated = await responseJson(updatedResponse);

    expect(updatedResponse.status).toBe(200);
    expect(updated.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", enabled: true }),
        expect.objectContaining({ id: "claude", enabled: false }),
      ]),
    );
    const saved = JSON.parse(
      await fs.readFile(path.join(appData, "CodexBar", "config.json"), "utf8"),
    );
    expect(saved).toEqual({
      enabledProviders: ["codex"],
      syntheticApiKey: "not-returned",
    });

    const stale = await PUT(
      request({
        providerId: "cursor",
        enabled: true,
        version: initial.version,
      }),
    );
    expect(stale.status).toBe(409);
  });

  it("creates config.json from missing file when first PUT uses '{}' version", async () => {
    await fs.rm(path.join(appData, "CodexBar", "config.json"), { force: true });
    const initial = await responseJson(await GET());
    expect(initial.version).toBe(versionOf("{}"));

    const response = await PUT(
      request({
        providerId: "openrouter",
        enabled: true,
        version: initial.version,
      }),
    );
    const body = await responseJson(response);
    expect(response.status).toBe(200);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "openrouter", enabled: true }),
        expect.objectContaining({ id: "codex", enabled: true }),
      ]),
    );
    const saved = JSON.parse(
      await fs.readFile(path.join(appData, "CodexBar", "config.json"), "utf8"),
    );
    expect(saved.enabledProviders).toEqual([
      "codex",
      "claude",
      "cursor",
      "openrouter",
    ]);
  });

  it("re-reads the version after a config-adjacent cross-process lock", async () => {
    const file = path.join(appData, "CodexBar", "config.json");
    const initial = await responseJson(await GET());
    const lockFile = `${file}.providers.lock`;
    const lock = await fs.open(lockFile, "wx", 0o600);
    const pending = PUT(
      request({
        providerId: "cursor",
        enabled: true,
        version: initial.version,
      }),
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await fs.writeFile(
        file,
        JSON.stringify({ enabledProviders: ["codex", "claude", "synthetic"] }),
      );
    } finally {
      await lock.close();
      await fs.unlink(lockFile);
    }

    expect((await pending).status).toBe(409);
  });

  it("rejects unknown input and disabling the final enabled provider", async () => {
    const initial = await responseJson(await GET());
    expect(
      await PUT(
        request({
          providerId: "unknown",
          enabled: true,
          version: initial.version,
        }),
      ),
    ).toMatchObject({ status: 400 });

    await fs.writeFile(
      path.join(appData, "CodexBar", "config.json"),
      JSON.stringify({ enabledProviders: ["codex"] }),
    );
    const single = await responseJson(await GET());
    const response = await PUT(
      request({
        providerId: "codex",
        enabled: false,
        version: single.version,
      }),
    );
    expect(response.status).toBe(400);
  });

  it("does not overwrite a missing or malformed config", async () => {
    const file = path.join(appData, "CodexBar", "config.json");
    await fs.writeFile(file, "{broken secret-looking text");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await fs.readFile(file, "utf8")).toBe("{broken secret-looking text");
  });

  it("parses config.json written with a UTF-8 BOM (native CodexBar app export)", async () => {
    const file = path.join(appData, "CodexBar", "config.json");
    const bom = "\ufeff";
    await fs.writeFile(
      file,
      bom + JSON.stringify({ enabledProviders: ["codex", "claude"] }),
      "utf8",
    );

    const response = await GET();
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", enabled: true }),
        expect.objectContaining({ id: "claude", enabled: true }),
        expect.objectContaining({ id: "cursor", enabled: false }),
      ]),
    );
  });
});
