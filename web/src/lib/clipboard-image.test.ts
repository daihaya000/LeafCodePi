import { describe, expect, it, vi } from "vitest";
import {
  canAttachComposerImages,
  clipboardHasImage,
  pasteImage,
} from "./clipboard-image";

function clipboardEvent(items: Array<{ kind: string; type: string; file?: File | null }>) {
  return {
    clipboardData: {
      items: items.map((item) => ({
        kind: item.kind,
        type: item.type,
        getAsFile: () => item.file ?? null,
      })),
    } as unknown as DataTransfer,
    preventDefault: vi.fn(),
  };
}

describe("canAttachComposerImages", () => {
  it("matches the composer attachment-button disabled states", () => {
    expect(canAttachComposerImages({})).toBe(true);
    expect(canAttachComposerImages({ goalLoopEnabled: true })).toBe(false);
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

  it("still reports images when the consumer rejects attachment", () => {
    const file = new File(["img"], "shot.png", { type: "image/png" });
    const onFiles = vi.fn((files: FileList) => {
      if (!canAttachComposerImages({ goalLoopEnabled: true })) return;
      void files;
    });
    const event = clipboardEvent([{ kind: "file", type: "image/png", file }]);

    // Goal loop 等で添付拒否しても true を返し、呼び出し側が preventDefault できる。
    expect(pasteImage(onFiles, event)).toBe(true);
    expect(onFiles).toHaveBeenCalledOnce();
  });
});
