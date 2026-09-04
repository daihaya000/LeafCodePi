import { describe, expect, it } from "vitest";
import { canAttachComposerImages } from "./clipboard-image";

describe("canAttachComposerImages", () => {
  it("matches the composer attachment-button disabled states", () => {
    expect(canAttachComposerImages({})).toBe(true);
    expect(canAttachComposerImages({ goalLoopEnabled: true })).toBe(false);
    expect(canAttachComposerImages({ compacting: true })).toBe(false);
    expect(canAttachComposerImages({ submitting: true })).toBe(false);
    expect(canAttachComposerImages({ archived: true })).toBe(false);
  });
});
