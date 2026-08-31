import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OLLAMA_CLOUD_BASE,
  effectiveBaseUrl,
  isEditableBaseUrlProvider,
  readProviderEndpoints,
  REMOTE_PROVIDER_BASE,
  setProviderBaseUrl,
} from "@/lib/provider-endpoints";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.LEAFCODE_PI_DATA_DIR;
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "leafcode-pi-pe-"));
  dirs.push(dir);
  process.env.LEAFCODE_PI_DATA_DIR = dir;
  return dir;
}

describe("provider-endpoints", () => {
  it("returns the default base URLs when no file exists", () => {
    tempDataDir();
    expect(readProviderEndpoints()).toEqual({
      "ollama-cloud": DEFAULT_OLLAMA_CLOUD_BASE,
      leafcodecloud: REMOTE_PROVIDER_BASE,
    });
    expect(isEditableBaseUrlProvider("ollama-cloud")).toBe(true);
    expect(isEditableBaseUrlProvider("anthropic")).toBe(false);
  });

  it("round-trips a stored base URL and exposes it via effectiveBaseUrl", () => {
    tempDataDir();
    setProviderBaseUrl("ollama-cloud", "http://localhost:11434/v1");
    expect(readProviderEndpoints()["ollama-cloud"]).toBe(
      "http://localhost:11434/v1",
    );
    expect(effectiveBaseUrl("ollama-cloud")).toBe(
      "http://localhost:11434/v1",
    );
    expect(effectiveBaseUrl("leafcodecloud")).toBe(REMOTE_PROVIDER_BASE);
  });

  it("normalizes whitespace and trailing slashes", () => {
    tempDataDir();
    setProviderBaseUrl("ollama-cloud", "  https://example.com/v1/  ");
    expect(readProviderEndpoints()["ollama-cloud"]).toBe(
      "https://example.com/v1",
    );
  });

  it("rejects invalid URLs with a status 400", () => {
    tempDataDir();
    expect(() => setProviderBaseUrl("ollama-cloud", "not-a-url")).toThrow(
      /http/,
    );
    expect(() => setProviderBaseUrl("ollama-cloud", "ftp://example.com")).toThrow(
      /http/,
    );
    expect(() => setProviderBaseUrl("anthropic", "https://x.com/v1")).toThrow(
      /変更できる/,
    );
  });

  it("ignores malformed known values and preserves unknown keys when writing", () => {
    const dir = tempDataDir();
    writeFileSync(
      join(dir, "provider-endpoints.json"),
      JSON.stringify({
        "ollama-cloud": "https://kept.example/v1",
        unknownKey: { keep: true },
        leafcodecloud: "invalid",
      }),
      "utf8",
    );
    const endpoints = readProviderEndpoints();
    expect(endpoints["ollama-cloud"]).toBe("https://kept.example/v1");
    expect(endpoints.leafcodecloud).toBe(REMOTE_PROVIDER_BASE);

    setProviderBaseUrl("leafcodecloud", "https://updated.example/v1");
    const stored = JSON.parse(
      readFileSync(join(dir, "provider-endpoints.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored.unknownKey).toEqual({ keep: true });
    expect(stored["ollama-cloud"]).toBe("https://kept.example/v1");
    expect(stored.leafcodecloud).toBe("https://updated.example/v1");

    writeFileSync(join(dir, "provider-endpoints.json"), "{ not json", "utf8");
    expect(readProviderEndpoints()).toEqual({
      "ollama-cloud": DEFAULT_OLLAMA_CLOUD_BASE,
      leafcodecloud: REMOTE_PROVIDER_BASE,
    });
  });
});
