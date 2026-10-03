import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { defaultModelDir, GET, isLora, isMmProj, resetLlamaModelScanCacheForTests } from "./route";

describe("model asset classification", () => {
  it("recognizes mmproj files even when the prefix is the model family", () => {
    expect(isMmProj("Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf")).toBe(true);
    expect(isMmProj("Qwen3.8-27B.gguf")).toBe(false);
    expect(isLora("gguf/bonsai-abliterate-lora.gguf")).toBe(true);
  });
});

describe("model directory scan caching", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetLlamaModelScanCacheForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("serves the second listing from the cache and rescans after a change", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "llama-models-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "a.gguf"), "a", "utf8");
    const request = () => new NextRequest(`http://127.0.0.1:3010/api/llama-server/models?dir=${encodeURIComponent(dir)}`);

    const first = await (await GET(request())).json();
    expect(first.models).toEqual(["a.gguf"]);

    // A new file changes the directory mtime, so the cached listing must not be served.
    writeFileSync(path.join(dir, "b.gguf"), "b", "utf8");
    const second = await (await GET(request())).json();
    expect(second.models).toEqual(["a.gguf", "b.gguf"]);
  });
});

describe("defaultModelDir", () => {
  it("uses the POSIX home model directory on Linux", () => {
    expect(defaultModelDir("linux", { NODE_ENV: "test" })).toBe(
      path.join(homedir(), "models", "llm"),
    );
  });

  it("prefers the configured model directory on Linux", () => {
    expect(
      defaultModelDir("linux", {
        NODE_ENV: "test",
        LEAFCODE_PI_LLAMA_MODEL_DIR: "/srv/models/llm",
      }),
    ).toBe("/srv/models/llm");
  });
});
