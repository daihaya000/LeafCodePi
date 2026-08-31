import { describe, expect, it } from "vitest";
import { providerIconSrc, providerIconSrcForModelValue } from "@/lib/provider-icons";

describe("providerIconSrc", () => {
  it("maps common Pi provider ids to bundled icons", () => {
    expect(providerIconSrc("anthropic")).toBe("/icons/claude.png");
    expect(providerIconSrc("openai-codex")).toBe("/icons/codex.png");
    expect(providerIconSrc("cursor")).toBe("/icons/cursor.png");
    expect(providerIconSrc("llama-server")).toBe("/icons/llama-server.png");
    expect(providerIconSrc("ollama-cloud")).toBe("/icons/ollama.png");
    expect(providerIconSrc("openrouter")).toBe("/icons/openrouter.svg");
    expect(providerIconSrc("auto")).toBe("/icons/leafcodegreen.png");
    expect(providerIconSrc("LeafCodeCloud")).toBe("/icons/leafcode.png");
  });

  it("returns null for unknown providers", () => {
    expect(providerIconSrc("mystery")).toBeNull();
    expect(providerIconSrc("")).toBeNull();
  });

  it("parses model values", () => {
    expect(providerIconSrcForModelValue("anthropic::claude-sonnet")).toBe("/icons/claude.png");
    expect(providerIconSrcForModelValue("cursor::composer-1")).toBe("/icons/cursor.png");
  });
});
