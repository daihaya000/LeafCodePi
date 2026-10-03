import { describe, expect, it } from "vitest";
import { stripImageDataFromMessages } from "@/lib/task-history";

const PNG = "A".repeat(200_000);

describe("stripImageDataFromMessages", () => {
  it("empties image data URLs but keeps the id, mime and filename", () => {
    const messages = [
      {
        id: "u1",
        role: "user",
        createdAt: 1,
        parts: [
          { id: "u1-text", type: "text", text: "このログを確認してください" },
          { id: "u1-image", type: "image", mime: "image/png", url: `data:image/png;base64,${PNG}`, filename: "shot.png" },
        ],
      },
    ] as never;

    const stripped = stripImageDataFromMessages(messages);

    expect(stripped).toHaveLength(1);
    const parts = stripped[0]!.parts;
    expect(parts[0]).toMatchObject({ type: "text", text: "このログを確認してください" });
    expect(parts[1]).toMatchObject({ id: "u1-image", type: "image", mime: "image/png", url: "", filename: "shot.png" });
  });

  it("leaves messages without images untouched by identity", () => {
    const message = { id: "a1", role: "assistant", createdAt: 2, parts: [{ id: "a1-text", type: "text", text: "了解" }] } as never;
    expect(stripImageDataFromMessages([message])[0]).toBe(message);
  });

  it("keeps non-data image urls so server-rendered images still render", () => {
    const message = {
      id: "u2",
      role: "user",
      createdAt: 3,
      parts: [{ id: "u2-image", type: "image", mime: "image/png", url: "/api/tasks/t1/image?path=shot.png" }],
    } as never;
    const parts = stripImageDataFromMessages([message])[0]!.parts;
    expect(parts[0]).toMatchObject({ url: "/api/tasks/t1/image?path=shot.png" });
  });

  it("shrinks the serialized page to roughly the text size", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      id: `u${index}`,
      role: "user",
      createdAt: index,
      parts: [
        { id: `u${index}-text`, type: "text", text: "確認してください" },
        { id: `u${index}-image`, type: "image", mime: "image/png", url: `data:image/png;base64,${PNG}` },
      ],
    })) as never;

    const before = JSON.stringify(messages).length;
    const after = JSON.stringify(stripImageDataFromMessages(messages)).length;

    expect(after).toBeLessThan(before / 10);
  });
});
