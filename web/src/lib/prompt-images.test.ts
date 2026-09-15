import { describe, expect, it } from "vitest";
import {
  decodePromptFile,
  formatPromptWithFiles,
  isPromptFile,
  isPromptFileList,
  isPromptImageList,
  isPromptFileText,
  MAX_PROMPT_FILE_TOTAL_BYTES,
  MAX_PROMPT_IMAGE_TOTAL_BYTES,
  MAX_PROMPT_TEXT_CHARS,
  isPromptTextWithinSize,
  parsePromptFileMarkers,
} from "./prompt-images";

describe("prompt text", () => {
  it("bounds direct user input by code point", () => {
    expect(isPromptTextWithinSize("😀".repeat(MAX_PROMPT_TEXT_CHARS))).toBe(true);
    expect(isPromptTextWithinSize("😀".repeat(MAX_PROMPT_TEXT_CHARS + 1))).toBe(false);
  });
});

describe("prompt image attachments", () => {
  it("bounds aggregate vision input", () => {
    const half = Math.floor(MAX_PROMPT_IMAGE_TOTAL_BYTES / 2) + 1;
    const images = [
      { mimeType: "image/png", data: Buffer.alloc(half).toString("base64") },
      { mimeType: "image/png", data: Buffer.alloc(half).toString("base64") },
    ];

    expect(isPromptImageList(images)).toBe(false);
  });
});

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

  it("bounds the aggregate text sent to the model", () => {
    const half = Math.floor(MAX_PROMPT_FILE_TOTAL_BYTES / 2) + 1;
    const files = [
      { ...file, name: "first.txt", data: Buffer.alloc(half, "a").toString("base64") },
      { ...file, name: "second.txt", data: Buffer.alloc(half, "b").toString("base64") },
    ];

    expect(isPromptFileList(files)).toBe(false);
    expect(() => formatPromptWithFiles("確認", files)).toThrow("合計");
  });

  it("rejects binary content before it reaches the prompt", () => {
    const binary = { ...file, data: Buffer.from([0xff, 0xfe]).toString("base64") };
    expect(isPromptFile(binary)).toBe(true);
    expect(isPromptFileText(binary)).toBe(false);
    expect(() => formatPromptWithFiles("確認", [binary])).toThrow("UTF-8");
  });
});
