import { describe, expect, it } from "vitest";
import {
  displayNameFromOllamaId,
  inferOllamaCapabilities,
  parseOllamaCloudModelsPayload,
  toOllamaCloudModel,
} from "./ollama-cloud-provider";

describe("ollama-cloud-provider", () => {
  it("parses /v1/models payloads", () => {
    expect(
      parseOllamaCloudModelsPayload({
        object: "list",
        data: [{ id: "gpt-oss:120b" }, { id: "  " }, { id: 1 }, { id: "glm-5.2" }],
      }),
    ).toEqual(["gpt-oss:120b", "glm-5.2"]);
    expect(parseOllamaCloudModelsPayload(null)).toEqual([]);
  });

  it("builds openai-completions models for Ollama Cloud", () => {
    const model = toOllamaCloudModel("gpt-oss:120b");
    expect(model).toMatchObject({
      id: "gpt-oss:120b",
      name: "gpt-oss:120b",
      provider: "ollama-cloud",
      api: "openai-completions",
      baseUrl: "https://ollama.com/v1",
      reasoning: true,
    });
    expect(displayNameFromOllamaId("qwen3.5:397b")).toBe("qwen3.5:397b");
  });

  it("infers vision / reasoning hints from ids", () => {
    expect(inferOllamaCapabilities("gemma4:31b").input).toContain("image");
    expect(inferOllamaCapabilities("qwen2.5vl:7b").input).toContain("image");
    expect(inferOllamaCapabilities("gemma3:27b").input).toContain("image");
    expect(inferOllamaCapabilities("llama4:scout").input).toContain("image");
    expect(inferOllamaCapabilities("llava:13b").input).toContain("image");
    expect(inferOllamaCapabilities("minicpm-v:8b").input).toContain("image");
    expect(inferOllamaCapabilities("mistral-small3.2:24b").input).toContain("image");
    expect(inferOllamaCapabilities("llama3:8b").input).toEqual(["text"]);
    expect(inferOllamaCapabilities("gpt-oss:20b").reasoning).toBe(true);
  });
});
