import { describe, expect, it } from "vitest";
import {
  catalogFromRoomUserRequest,
  catalogFromSessionEntries,
  parseCodeSessionImageIndexes,
  resolveBotCodeImages,
} from "./bot-code-images";

const png = (data: string, latestUser = false) => ({ mimeType: "image/png", data, latestUser });

describe("parseCodeSessionImageIndexes", () => {
  it("accepts omitted, numbers, and numeric strings", () => {
    expect(parseCodeSessionImageIndexes(undefined)).toBeUndefined();
    expect(parseCodeSessionImageIndexes([1, 3])).toEqual([1, 3]);
    expect(parseCodeSessionImageIndexes(["2"])).toEqual([2]);
  });

  it("rejects invalid values", () => {
    expect(() => parseCodeSessionImageIndexes("1")).toThrow("array");
    expect(() => parseCodeSessionImageIndexes([0])).toThrow("1-based");
    expect(() => parseCodeSessionImageIndexes([1.5])).toThrow("1-based");
    expect(() => parseCodeSessionImageIndexes([1, 2, 3, 4, 5, 6, 7, 8, 9])).toThrow("limited");
  });
});

describe("catalogFromSessionEntries", () => {
  it("marks only the latest user turn as latestUser, including text-only latest turns", () => {
    const catalog = catalogFromSessionEntries([
      { type: "message", message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "old" }] } },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { message: { role: "user", content: [{ type: "text", text: "now code this" }] } },
    ]);
    expect(catalog).toEqual([png("old", false)]);
  });

  it("collects several images on the latest user message", () => {
    const catalog = catalogFromSessionEntries([
      { role: "user", content: [{ type: "image", data: "a", mimeType: "image/jpeg" }, { type: "image", data: "b", mimeType: "image/webp" }] },
    ]);
    expect(catalog).toEqual([
      { mimeType: "image/jpeg", data: "a", latestUser: true },
      { mimeType: "image/webp", data: "b", latestUser: true },
    ]);
  });
});

describe("catalogFromRoomUserRequest", () => {
  it("loads only the current user request, not older room messages", () => {
    const catalog = catalogFromRoomUserRequest(
      [
        { id: "user-1", role: "user" },
        { id: "bot-1", role: "assistant" },
        { id: "user-2", role: "user" },
      ],
      (id) => (id === "user-1" ? [{ mimeType: "image/png", data: "old" }] : [{ mimeType: "image/png", data: "now" }]),
    );
    expect(catalog).toEqual([png("now", true)]);
  });
});

describe("resolveBotCodeImages", () => {
  const catalog = [png("old"), png("latest-a", true), png("latest-b", true)];

  it("honors explicit indexes and treats [] as none", () => {
    expect(resolveBotCodeImages({ catalog, selected: [1] })).toMatchObject({
      images: [{ mimeType: "image/png", data: "old" }],
      attachedIndexes: [1],
    });
    expect(resolveBotCodeImages({ catalog, selected: [] })).toEqual({
      availableImages: [
        { index: 1, mimeType: "image/png", latestUser: false },
        { index: 2, mimeType: "image/png", latestUser: true },
        { index: 3, mimeType: "image/png", latestUser: true },
      ],
      attachedIndexes: [],
    });
  });

  it("defaults to latest-user images only", () => {
    expect(resolveBotCodeImages({ catalog })).toMatchObject({
      images: [
        { mimeType: "image/png", data: "latest-a" },
        { mimeType: "image/png", data: "latest-b" },
      ],
      attachedIndexes: [2, 3],
    });
  });

  it("honors selected images and otherwise uses latest-user images", () => {
    expect(resolveBotCodeImages({ catalog, selected: [2] })).toMatchObject({
      images: [{ mimeType: "image/png", data: "latest-a" }],
      attachedIndexes: [2],
    });
    expect(resolveBotCodeImages({ catalog })).toMatchObject({
      images: [
        { mimeType: "image/png", data: "latest-a" },
        { mimeType: "image/png", data: "latest-b" },
      ],
      attachedIndexes: [2, 3],
    });
  });

  it("rejects unknown indexes", () => {
    expect(() => resolveBotCodeImages({ catalog, selected: [9] })).toThrow("Unknown image index 9");
  });
});
