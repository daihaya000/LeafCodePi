import { readFileSync } from "node:fs";
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
    expect(providerIconSrc("orcarouter")).toBe("/icons/orcarouter.png");
    expect(providerIconSrc(" OpenDesign ")).toBe("/icons/opendesign.png");
    expect(providerIconSrc("typesafe")).toBe("/icons/typesafe.png");
    expect(providerIconSrc("auto")).toBe("/icons/leafcode.png");
    expect(providerIconSrc("LeafCodeCloud")).toBe("/icons/leafcodegreen.png");
  });

  it("bundles the OpenDesign logo as a 128px PNG", () => {
    const png = readFileSync(new URL("../../public/icons/opendesign.png", import.meta.url));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(128);
    expect(png.readUInt32BE(20)).toBe(128);
  });

  it("returns null for unknown providers", () => {
    expect(providerIconSrc("mystery")).toBeNull();
    expect(providerIconSrc("")).toBeNull();
  });

  it("parses model values", () => {
    expect(providerIconSrcForModelValue("anthropic::claude-sonnet")).toBe("/icons/claude.png");
    expect(providerIconSrcForModelValue("cursor::composer-1")).toBe("/icons/cursor.png");
    expect(providerIconSrcForModelValue("orcarouter::auto")).toBe("/icons/orcarouter.png");
    expect(providerIconSrcForModelValue("opendesign::fixture-chat")).toBe("/icons/opendesign.png");
  });
});
