import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLAMA_SERVER_SETTINGS,
  findLlamaModelPreset,
  isLlamaServerSettings,
  isSafeLlamaSystemPrompt,
  isLlamaSpecComboBroken,
  isSafeLlamaModelFile,
  isSafeLlamaPathValue,
  LLAMA_MODEL_PRESETS,
  LLAMA_SERVER_EFFORTS,
  LLAMA_SERVER_SPEC_TYPES,
  LLAMA_SERVER_SYSTEM_PROMPT_MAX_CHARS,
  parseLlamaServerSettings,
  resolveLlamaServerBin,
  serializeLlamaServerSettings,
} from "@/lib/llama-server-settings";

describe("llama-server-settings", () => {
  it("exposes none/low/medium/xhigh as the valid efforts", () => {
    expect(LLAMA_SERVER_EFFORTS).toEqual(["", "low", "medium", "xhigh"]);
  });

  it("accepts an empty effort (models without a reasoning template)", () => {
    expect(
      isLlamaServerSettings({ effort: "", contextLength: 131072, parallel: 1 }),
    ).toBe(true);
  });

  it("accepts a well-formed settings object", () => {
    const valid = { effort: "medium", contextLength: 131072, parallel: 4 };
    expect(isLlamaServerSettings(valid)).toBe(true);
  });

  it("accepts multiline system prompts and rejects unsafe size/control values", () => {
    expect(isSafeLlamaSystemPrompt("日本語で回答する\n簡潔にする")).toBe(true);
    expect(isSafeLlamaSystemPrompt("\u0000")).toBe(false);
    expect(isSafeLlamaSystemPrompt("x".repeat(LLAMA_SERVER_SYSTEM_PROMPT_MAX_CHARS + 1))).toBe(false);
    expect(
      isLlamaServerSettings({
        effort: "low",
        contextLength: 4096,
        parallel: 1,
        systemPrompt: "You are a coding assistant.",
      }),
    ).toBe(true);
  });

  it("rejects an effort outside the allowlist", () => {
    expect(
      isLlamaServerSettings({ effort: "high", contextLength: 131072, parallel: 1 }),
    ).toBe(false);
  });

  it("rejects a non-integer contextLength", () => {
    expect(
      isLlamaServerSettings({ effort: "low", contextLength: 1.5, parallel: 1 }),
    ).toBe(false);
  });

  it("rejects a parallel below 1 or above 16", () => {
    expect(
      isLlamaServerSettings({ effort: "low", contextLength: 4096, parallel: 0 }),
    ).toBe(false);
    expect(
      isLlamaServerSettings({ effort: "low", contextLength: 4096, parallel: 17 }),
    ).toBe(false);
  });

  it("returns defaults when the stored value is null", () => {
    expect(parseLlamaServerSettings(null)).toEqual(DEFAULT_LLAMA_SERVER_SETTINGS);
  });

  it("returns defaults when the stored value is invalid JSON", () => {
    expect(parseLlamaServerSettings("{bad")).toEqual(DEFAULT_LLAMA_SERVER_SETTINGS);
  });

  it("round-trips through serialize and parse", () => {
    const settings = {
      effort: "xhigh" as const,
      contextLength: 262144,
      parallel: 2,
      systemPrompt: "Answer in Japanese.\nKeep it concise.",
      llamaCppPath: "C:\\tools\\llama.cpp",
      modelDir: "D:\\models\\llm",
      modelFile: "repoA\\model-Q4_K_S.gguf",
      llamaServerHost: "0.0.0.0" as const,
      specType: "draft-mtp" as const,
      cacheTypeK: "q8_0" as const,
      cacheTypeV: "q8_0" as const,
    };
    const raw = serializeLlamaServerSettings(settings);
    expect(parseLlamaServerSettings(raw)).toEqual(settings);
  });

  it("fills path defaults for a config saved before the path fields existed", () => {
    const legacy = JSON.stringify({ effort: "medium", contextLength: 131072, parallel: 2 });
    expect(isLlamaServerSettings(JSON.parse(legacy))).toBe(true);
    expect(parseLlamaServerSettings(legacy)).toEqual({
      effort: "medium",
      contextLength: 131072,
      parallel: 2,
      systemPrompt: "",
      llamaCppPath: "",
      modelDir: "",
      modelFile: "",
      llamaServerHost: "127.0.0.1",
      specType: "",
      cacheTypeK: "",
      cacheTypeV: "",
    });
  });

  it("accepts only the known speculative decoding types", () => {
    expect(LLAMA_SERVER_SPEC_TYPES).toEqual(["", "draft-mtp"]);
    const base = { effort: "low", contextLength: 4096, parallel: 1 };
    expect(isLlamaServerSettings(base)).toBe(true);
    expect(isLlamaServerSettings({ ...base, specType: "" })).toBe(true);
    expect(isLlamaServerSettings({ ...base, specType: "draft-mtp" })).toBe(true);
    expect(isLlamaServerSettings({ ...base, specType: "ngram-simple" })).toBe(false);
    expect(isLlamaServerSettings({ ...base, specType: 'evil" & calc' })).toBe(false);
  });

  it("matches model presets by file path", () => {
    const ornith = findLlamaModelPreset(
      "Ornith-1.5-35B-A3B-GGUF\\Ornith-1.5-35B-A3B-AD-Q5_K-Q4_K.gguf",
    );
    expect(ornith?.key).toBe("ornith");
    expect(ornith?.settings).toEqual({
      effort: "",
      specType: "",
      contextLength: 131_072,
      cacheTypeK: "",
      cacheTypeV: "q8_0",
    });

    const ornithThinking = LLAMA_MODEL_PRESETS.find((p) => p.key === "ornith-thinking");
    expect(ornithThinking?.label).toContain("思考つき");
    expect(ornithThinking?.settings).toEqual({
      effort: "",
      specType: "",
      contextLength: 131_072,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
    });

    const qwen = findLlamaModelPreset("Qwen3.8-27B-Uncensored-GGUF\\model.gguf");
    expect(qwen?.key).toBe("qwen38");
    expect(qwen?.settings.specType).toBe("draft-mtp");
    expect(qwen?.settings.cacheTypeK).toBe("q8_0");

    const huihui = findLlamaModelPreset(
      "huihui-ai\\Huihui-Qwen3.8-27B-abliterated-GGUF\\Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf",
    );
    expect(huihui?.key).toBe("huihui-qwen38");
    expect(huihui?.settings).toEqual({
      effort: "low",
      specType: "draft-mtp",
      contextLength: 131_072,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
    });
    expect(findLlamaModelPreset("Qwen3.8-27B-huihui-abliterated-Q4_K.gguf")?.key).toBe(
      "huihui-qwen38",
    );

    expect(findLlamaModelPreset("unknown-model.gguf")).toBeNull();
    expect(findLlamaModelPreset("")).toBeNull();
  });

  it("accepts only the known KV cache types", () => {
    const base = { effort: "low", contextLength: 4096, parallel: 1 };
    expect(isLlamaServerSettings({ ...base, cacheTypeK: "", cacheTypeV: "q8_0" })).toBe(true);
    expect(isLlamaServerSettings({ ...base, cacheTypeV: "f16" })).toBe(true);
    expect(isLlamaServerSettings({ ...base, cacheTypeK: "q4_0" })).toBe(false);
    expect(isLlamaServerSettings({ ...base, cacheTypeV: 'evil" & calc' })).toBe(false);
    expect(isLlamaServerSettings(base)).toBe(true);
  });

  it("flags broken spec/model combinations", () => {
    // Ornith has no MTP tensors -> draft-mtp would fail to load.
    expect(isLlamaSpecComboBroken("Ornith-1.5-x.gguf", "draft-mtp")).toBe(true);
    expect(isLlamaSpecComboBroken("Ornith-1.5-x.gguf", "")).toBe(false);
    // Qwen3.8 ships MTP tensors -> draft-mtp is fine.
    expect(isLlamaSpecComboBroken("Qwen3.8-27B-Q4_K_S.gguf", "draft-mtp")).toBe(false);
    // Huihui keeps the Qwen3.8 MTP tensors unchanged.
    expect(
      isLlamaSpecComboBroken("Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf", "draft-mtp"),
    ).toBe(false);
    expect(isLlamaSpecComboBroken("", "draft-mtp")).toBe(true);
  });

  it("rejects a path value cmd.exe could reinterpret", () => {
    for (const bad of ['C:\\a" & calc & "', "C:\\a%PATH%", "C:\\a!b!", "C:\\a\r\nb", "C:\\a^b"]) {
      expect(isSafeLlamaPathValue(bad)).toBe(false);
    }
    expect(isSafeLlamaPathValue("C:\\Users\\me\\models\\llm")).toBe(true);
    expect(isSafeLlamaPathValue("")).toBe(true);
    expect(isSafeLlamaPathValue(`C:\\${"a".repeat(400)}`)).toBe(false);
  });

  it("keeps modelFile relative, traversal-free and .gguf", () => {
    expect(isSafeLlamaModelFile("repoA\\model.gguf")).toBe(true);
    expect(isSafeLlamaModelFile("model.GGUF")).toBe(true);
    expect(isSafeLlamaModelFile("")).toBe(true);
    expect(isSafeLlamaModelFile("D:\\abs\\model.gguf")).toBe(false);
    expect(isSafeLlamaModelFile("\\model.gguf")).toBe(false);
    expect(isSafeLlamaModelFile("..\\..\\model.gguf")).toBe(false);
    expect(isSafeLlamaModelFile("repoA\\model.bin")).toBe(false);
  });

  it("rejects a settings object carrying an unsafe path", () => {
    const base = { effort: "low", contextLength: 4096, parallel: 1 };
    expect(isLlamaServerSettings({ ...base, modelDir: 'C:\\a" & calc' })).toBe(false);
    expect(isLlamaServerSettings({ ...base, modelFile: "..\\evil.gguf" })).toBe(false);
    expect(isLlamaServerSettings({ ...base, llamaCppPath: "C:\\tools\\llama.cpp" })).toBe(true);
  });

  it("accepts only the known bind addresses", () => {
    const base = { effort: "low", contextLength: 4096, parallel: 1 };
    expect(isLlamaServerSettings({ ...base, llamaServerHost: "127.0.0.1" })).toBe(true);
    expect(isLlamaServerSettings({ ...base, llamaServerHost: "0.0.0.0" })).toBe(true);
    expect(isLlamaServerSettings({ ...base, llamaServerHost: "192.168.1.5" })).toBe(false);
    expect(isLlamaServerSettings({ ...base, llamaServerHost: "evil;calc" })).toBe(false);
    expect(isLlamaServerSettings({ ...base })).toBe(true);
  });

  it("appends llama-server.exe only when the install path is a folder", () => {
    expect(resolveLlamaServerBin("C:\\tools\\llama.cpp")).toBe(
      "C:\\tools\\llama.cpp\\llama-server.exe",
    );
    expect(resolveLlamaServerBin("C:\\tools\\llama.cpp\\")).toBe(
      "C:\\tools\\llama.cpp\\llama-server.exe",
    );
    expect(resolveLlamaServerBin("C:\\tools\\llama.cpp\\llama-server.exe")).toBe(
      "C:\\tools\\llama.cpp\\llama-server.exe",
    );
    expect(resolveLlamaServerBin("  ")).toBe("");
  });
});
