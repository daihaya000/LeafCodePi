import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultModelDir } from "./route";

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
