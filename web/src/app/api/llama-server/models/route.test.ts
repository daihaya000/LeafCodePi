import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultModelDir,
  GET,
  isForbiddenModelDirectory,
  isLora,
  isMmProj,
  isUnderAllowedModelRoot,
  knownModelDirectoryRoots,
  parseModelDirAllowlist,
  resetLlamaModelScanCacheForTests,
} from "./route";

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
    const previous = process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST;
    process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST = dir;
    try {
      const request = () => new NextRequest(`http://127.0.0.1:3010/api/llama-server/models?dir=${encodeURIComponent(dir)}`);

      const first = await (await GET(request())).json();
      expect(first.models).toEqual(["a.gguf"]);

      // A new file changes the directory mtime, so the cached listing must not be served.
      writeFileSync(path.join(dir, "b.gguf"), "b", "utf8");
      const second = await (await GET(request())).json();
      expect(second.models).toEqual(["a.gguf", "b.gguf"]);
    } finally {
      if (previous === undefined) delete process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST;
      else process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST = previous;
    }
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

describe("model directory target safety", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetLlamaModelScanCacheForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const request = (dir: string) =>
    new NextRequest(`http://127.0.0.1:3010/api/llama-server/models?dir=${encodeURIComponent(dir)}`);

  it("refuses a UNC network path so the server never walks a remote share", async () => {
    const unc = String.raw`\\server\models`;
    const response = await GET(request(unc));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/ネットワーク/);
  });

  it("refuses a drive-relative path, which resolves against per-drive cwd", async () => {
    const response = await GET(request("C:models"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/ネットワーク/);
  });

  it("serves a local directory only when it is on the allowlist", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "llama-local-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "local.gguf"), "a", "utf8");
    const previous = process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST;
    process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST = dir;
    try {
      const response = await GET(request(dir));
      expect(response.status).toBe(200);
      expect((await response.json()).models).toEqual(["local.gguf"]);
    } finally {
      if (previous === undefined) delete process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST;
      else process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST = previous;
    }
  });

  it("refuses an arbitrary local directory outside known roots and allowlist", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "llama-denied-"));
    dirs.push(dir);
    writeFileSync(path.join(dir, "secret.gguf"), "a", "utf8");
    const previous = process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST;
    delete process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST;
    try {
      const response = await GET(request(dir));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatch(/許可されたモデル保存先/);
    } finally {
      if (previous === undefined) delete process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST;
      else process.env.LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST = previous;
    }
  });
});

describe("model directory allowlist roots", () => {
  it("parses semicolon-separated absolute extras", () => {
    expect(parseModelDirAllowlist("/srv/a;/srv/b", "linux")).toEqual(["/srv/a", "/srv/b"]);
  });

  it("treats configured and allowlisted roots as allowed", () => {
    const roots = knownModelDirectoryRoots("linux", {
      NODE_ENV: "test",
      LEAFCODE_PI_LLAMA_MODEL_DIR: "/srv/models/llm",
      LEAFCODE_PI_LLAMA_MODEL_DIR_ALLOWLIST: "/mnt/ext;/data/gguf",
    }, "/opt/saved-models");
    expect(isUnderAllowedModelRoot("/srv/models/llm/qwen", roots, "linux")).toBe(true);
    expect(isUnderAllowedModelRoot("/mnt/ext/family", roots, "linux")).toBe(true);
    expect(isUnderAllowedModelRoot("/opt/saved-models", roots, "linux")).toBe(true);
    expect(isUnderAllowedModelRoot("/tmp/random", roots, "linux")).toBe(false);
  });
});

describe("system directory guard", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetLlamaModelScanCacheForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses virtual filesystems and OS trees", async () => {
    for (const forbidden of ["/proc", "/sys", "/dev", "/etc"]) {
      const response = await GET(
        new NextRequest(`http://127.0.0.1:3010/api/llama-server/models?dir=${encodeURIComponent(forbidden)}`),
      );
      expect(response.status, forbidden).toBe(400);
      expect((await response.json()).error).toMatch(/システムディレクトリ/);
    }
  });

  it("still allows an ordinary model directory", () => {
    expect(isForbiddenModelDirectory("/home/user/models", "linux")).toBe(false);
    expect(isForbiddenModelDirectory("/srv/llm", "linux")).toBe(false);
    expect(isForbiddenModelDirectory("/mnt/models", "linux")).toBe(false);
  });

  it("still allows a Windows drive and ProgramData siblings", () => {
    expect(isForbiddenModelDirectory(String.raw`C:\models`, "win32")).toBe(false);
    expect(isForbiddenModelDirectory(String.raw`D:\llm\gguf`, "win32")).toBe(false);
    expect(isForbiddenModelDirectory(String.raw`C:\Windows`, "win32")).toBe(true);
    expect(isForbiddenModelDirectory(String.raw`C:\Windows\System32\drivers`, "win32")).toBe(true);
  });
});
