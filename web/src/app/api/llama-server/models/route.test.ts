import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultModelDir, isLora, isMmProj } from "./route";

describe("model asset classification", () => {
  it("recognizes mmproj files even when the prefix is the model family", () => {
    expect(isMmProj("Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf")).toBe(true);
    expect(isMmProj("Qwen3.8-27B.gguf")).toBe(false);
    expect(isLora("gguf/bonsai-abliterate-lora.gguf")).toBe(true);
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
