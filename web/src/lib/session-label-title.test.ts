import { describe, expect, it } from "vitest";
import { splitTitleAndLabel } from "./direct-generation-text";

describe("splitTitleAndLabel", () => {
  it("takes the title from line 1 and the label from line 2", () => {
    expect(splitTitleAndLabel("バグを修正\nラベル: デバッグ")).toEqual({
      title: "バグを修正",
      labelName: "デバッグ",
    });
  });

  it("keeps the title even when the label line comes first", () => {
    expect(splitTitleAndLabel("ラベル：コード\n実装を追加")).toEqual({
      title: "実装を追加",
      labelName: "コード",
    });
  });

  it("returns no label when the response has only a title", () => {
    expect(splitTitleAndLabel("バグを修正")).toEqual({
      title: "バグを修正",
      labelName: null,
    });
  });

  it("strips quotes around the label name", () => {
    expect(splitTitleAndLabel('タイトル\nラベル: "デバッグ"').labelName).toBe("デバッグ");
  });
});
