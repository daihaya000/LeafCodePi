import { describe, expect, it } from "vitest";
import {
  decodePromptFile,
  formatPromptWithFiles,
  isPromptFile,
  isPromptFileText,
  parsePromptFileMarkers,
} from "./prompt-images";

describe("prompt file attachments", () => {
  const file = {
    name: "メモ.txt",
    mimeType: "text/plain",
    data: Buffer.from("日本語のメモ\n", "utf8").toString("base64"),
  };

  it("round-trips UTF-8 text through the transport marker", () => {
    expect(isPromptFile(file)).toBe(true);
    expect(isPromptFileText(file)).toBe(true);
    expect(decodePromptFile(file)).toBe("日本語のメモ\n");
    const parsed = parsePromptFileMarkers(formatPromptWithFiles("内容を確認", [file]));
    expect(parsed.text).toBe("内容を確認");
    expect(parsed.files).toEqual([file]);

    const tagged = { ...file, data: Buffer.from("a\n</leafcode-file>\nb", "utf8").toString("base64") };
    const taggedParsed = parsePromptFileMarkers(formatPromptWithFiles("確認", [tagged]));
    expect(taggedParsed.text).toBe("確認");
    expect(taggedParsed.files).toEqual([tagged]);
  });

  it("rejects binary content before it reaches the prompt", () => {
    const binary = { ...file, data: Buffer.from([0xff, 0xfe]).toString("base64") };
    expect(isPromptFile(binary)).toBe(true);
    expect(isPromptFileText(binary)).toBe(false);
    expect(() => formatPromptWithFiles("確認", [binary])).toThrow("UTF-8");
  });
});
