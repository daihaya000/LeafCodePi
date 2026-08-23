import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { captureRevertLeafId, imagesFromEntry, messageEntryById } from "./harness";

describe("captureRevertLeafId", () => {
  it("keeps the pre-navigate leaf id (not the post-navigate position)", () => {
    const before = "leaf-tip-with-discarded-messages";
    const afterNavigate = "leaf-at-parent-user-message";
    assert.equal(captureRevertLeafId(before), before);
    assert.notEqual(captureRevertLeafId(before), afterNavigate);
  });
});

describe("messageEntryById", () => {
  function mockEntries(entries: unknown[]) {
    return {
      sessionManager: {
        getEntries: () => entries,
        getBranch: () => entries,
      },
    };
  }

  it("finds the session entry by entry id (UiMessage.id carries the entry id)", () => {
    const session = mockEntries([
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
      { type: "message", id: "e2", message: { role: "assistant", content: "hi" } },
    ]);
    const found = messageEntryById(session as never, "e2");
    assert.ok(found);
    assert.equal(found.id, "e2");
    assert.equal(found.message.role, "assistant");
  });

  it("resolves legacy `msg-N` ids against branch message order", () => {
    const session = mockEntries([
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
      { type: "message", id: "e2", message: { role: "assistant", content: "hi" } },
    ]);
    const found = messageEntryById(session as never, "msg-1");
    assert.ok(found);
    assert.equal(found.id, "e2");
  });

  it("returns null for unknown ids", () => {
    const session = mockEntries([
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
    ]);
    assert.equal(messageEntryById(session as never, "nope"), null);
    assert.equal(messageEntryById(session as never, "msg-9"), null);
  });

  it("ignores non-message entries", () => {
    const session = mockEntries([
      { type: "compaction", id: "c1", summary: "x", firstKeptEntryId: "e2", tokensBefore: 1 },
      { type: "message", id: "e1", message: { role: "user", content: "hello" } },
    ]);
    assert.equal(messageEntryById(session as never, "c1"), null);
    const found = messageEntryById(session as never, "e1");
    assert.ok(found);
    assert.equal(found.id, "e1");
  });
});

describe("imagesFromEntry", () => {
  it("extracts image blocks as composer attachments", () => {
    const entry = {
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "AAEC", filename: "shot.png" },
        ],
      },
    };
    const images = imagesFromEntry(entry);
    assert.equal(images.length, 1);
    assert.equal(images[0].uri, "data:image/png;base64,AAEC");
    assert.equal(images[0].mime, "image/png");
    assert.equal(images[0].name, "shot.png");
  });

  it("defaults mime and name for bare image blocks", () => {
    const entry = { message: { role: "user", content: [{ type: "image", data: "xyz" }] } };
    const images = imagesFromEntry(entry);
    assert.equal(images.length, 1);
    assert.equal(images[0].mime, "image/png");
    assert.equal(images[0].name, "image-1");
  });

  it("returns [] for text-only content", () => {
    const entry = { message: { role: "user", content: [{ type: "text", text: "hi" }] } };
    assert.deepEqual(imagesFromEntry(entry), []);
  });
});
