import { describe, expect, it } from "vitest";
import { parseStructuredResult } from "./structured-result";

describe("parseStructuredResult", () => {
  it("parses a Goal Loop result JSON", () => {
    expect(
      parseStructuredResult(
        '{"status":"progress","summary":"テストを実行しました","next":"失敗箇所を確認します","evidence":"24件成功"}',
      ),
    ).toEqual({
      status: "progress",
      summary: "テストを実行しました",
      next: "失敗箇所を確認します",
      evidence: "24件成功",
    });
  });

  it("accepts fenced JSON and rejects unrelated objects", () => {
    expect(parseStructuredResult('```json\n{"status":"completed","summary":"完了"}\n```')).toEqual({
      status: "completed",
      summary: "完了",
    });
    expect(parseStructuredResult('{"name":"not a result"}')).toBeNull();
    expect(parseStructuredResult("通常の回答です")).toBeNull();
  });
});
