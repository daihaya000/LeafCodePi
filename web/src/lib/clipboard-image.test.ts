import { describe, expect, it, vi } from "vitest";
import {
  canAttachComposerImages,
  clipboardHasImage,
  LARGE_PASTE_CHAR_LIMIT,
  pasteImage,
  pasteLargeText,
  PASTED_TEXT_FILE_NAME,
} from "./clipboard-image";

function clipboardEvent(items: Array<{ kind: string; type: string; file?: File | null }>, text = "") {
  return {
    clipboardData: {
      items: items.map((item) => ({
        kind: item.kind,
        type: item.type,
        getAsFile: () => item.file ?? null,
      })),
      getData: (type: string) => type === "text/plain" ? text : "",
    } as unknown as DataTransfer,
    preventDefault: vi.fn(),
  };
}

describe("canAttachComposerImages", () => {
  it("matches the composer attachment-button disabled states", () => {
    expect(canAttachComposerImages({})).toBe(true);
    expect(canAttachComposerImages({ goalLoopEnabled: true })).toBe(true);
    expect(canAttachComposerImages({ compacting: true })).toBe(false);
    expect(canAttachComposerImages({ submitting: true })).toBe(false);
    expect(canAttachComposerImages({ archived: true })).toBe(false);
  });
});

describe("pasteImage", () => {
  it("forwards image files and returns true so callers can preventDefault", () => {
    const file = new File(["img"], "shot.png", { type: "image/png" });
    const onFiles = vi.fn();
    const event = clipboardEvent([{ kind: "file", type: "image/png", file }]);

    expect(clipboardHasImage(event)).toBe(true);
    expect(pasteImage(onFiles, event)).toBe(true);
    expect(onFiles).toHaveBeenCalledOnce();
    expect(Array.from(onFiles.mock.calls[0][0] as FileList)).toEqual([file]);
  });

  it("ignores text-only paste so normal typing paste still works", () => {
    const onFiles = vi.fn();
    const event = clipboardEvent([{ kind: "string", type: "text/plain" }]);

    expect(clipboardHasImage(event)).toBe(false);
    expect(pasteImage(onFiles, event)).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("allows images while Goal Loop is enabled", () => {
    const file = new File(["img"], "shot.png", { type: "image/png" });
    const onFiles = vi.fn((files: FileList) => {
      if (!canAttachComposerImages({ goalLoopEnabled: true })) return;
      void files;
    });
    const event = clipboardEvent([{ kind: "file", type: "image/png", file }]);

    expect(pasteImage(onFiles, event)).toBe(true);
    expect(onFiles).toHaveBeenCalledOnce();
  });
});

describe("pasteLargeText", () => {
  it("turns text over the limit into a text attachment", async () => {
    const text = "a".repeat(LARGE_PASTE_CHAR_LIMIT + 1);
    const onFiles = vi.fn();
    const event = clipboardEvent([], text);

    expect(pasteLargeText(onFiles, event)).toBe(true);
    const file = (onFiles.mock.calls[0]?.[0] as FileList)[0];
    expect(file?.name).toBe(PASTED_TEXT_FILE_NAME);
    expect(file?.type).toBe("text/plain");
    await expect(file?.text()).resolves.toBe(text);
  });

  it("leaves short text and image clipboard contents alone", () => {
    const onFiles = vi.fn();
    const short = clipboardEvent([], "a".repeat(LARGE_PASTE_CHAR_LIMIT));
    const image = clipboardEvent([{ kind: "file", type: "image/png", file: new File(["img"], "shot.png", { type: "image/png" }) }], "a".repeat(LARGE_PASTE_CHAR_LIMIT + 1));

    expect(pasteLargeText(onFiles, short)).toBe(false);
    expect(pasteLargeText(onFiles, image)).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });
});
