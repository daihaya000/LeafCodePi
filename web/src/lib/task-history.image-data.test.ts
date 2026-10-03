import { describe, expect, it } from "vitest";
import { imagePartDataUrl, stripImageDataFromMessages } from "@/lib/task-history";

const PNG = "A".repeat(120);

describe("imagePartDataUrl", () => {
  it("returns null for a message that is not present", () => {
    expect(imagePartDataUrl([], { messageId: "u1", partId: "u1-image" })).toBeNull();
  });

  it("returns null when the message has no such image part", () => {
    const messages = [
      { id: "u1", role: "user", createdAt: 1,
        parts: [{ id: "u1-image", type: "image", mime: "image/png", url: "" }] },
    ] as never;
    expect(imagePartDataUrl(messages, { messageId: "u1", partId: "u1-other" })).toBeNull();
  });

  it("rebuilds the data URL from a stripped part when its base64 is still known", () => {
    const withData = [
      { id: "u1", role: "user", createdAt: 1,
        parts: [{ id: "u1-image", type: "image", mime: "image/png", url: `data:image/png;base64,${PNG}` }] },
    ] as never;
    const stripped = stripImageDataFromMessages(withData);

    expect(stripped[0]!.parts[0]).toMatchObject({ url: "" });
    expect(imagePartDataUrl(withData, { messageId: "u1", partId: "u1-image" }))
      .toBe(`data:image/png;base64,${PNG}`);
  });

  it("returns null when the client already holds the stripped copy", () => {
    const messages = [
      { id: "u1", role: "user", createdAt: 1,
        parts: [{ id: "u1-image", type: "image", mime: "image/png", url: "" }] },
    ] as never;
    expect(imagePartDataUrl(messages, { messageId: "u1", partId: "u1-image" })).toBeNull();
  });
});
