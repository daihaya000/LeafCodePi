/**
 * LeafCode Question for Pi
 *
 * エージェントがユーザーに質問できる question ツールを登録する。
 * 本家 LeafCode（OpenCode）の question 機能相当。
 *
 * - TUI モード（ctx.hasUI）: ネイティブ UI で選択/入力
 * - WebUI モード: leafcode-permission-gate と同じグローバルブリッジで
 *   harness → SSE → QuestionCard へ流し、回答を待つ（タイムアウト時は null）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  requestWebUiQuestion,
  type WebUiQuestionInfo,
} from "./webui-question-bridge";

const params = Type.Object({
  question: Type.String({ description: "ユーザーに尋ねる質問文" }),
  header: Type.Optional(Type.String({ description: "短い見出し（カテゴリ名など・省略可）" })),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({ description: "選択肢の表示ラベル" }),
        description: Type.Optional(Type.String({ description: "選択肢の補足説明" })),
      }),
      { description: "選択肢一覧。省略した場合は自由記述のみ" },
    ),
  ),
  multiple: Type.Optional(Type.Boolean({ description: "複数選択を許可するか（既定: false）" })),
});

function extensionSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return "";
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "question",
    label: "Ask User",
    description:
      "Ask the user a question and wait for their answer. Use when a decision needs human input " +
      "(ambiguous requirements, confirmation of an approach, choosing between options). " +
      "Provide 2-4 concise options when possible; the user can always reply with custom text. " +
      "Do not use this for permission to run tools (that has its own approval flow).",
    promptSnippet: "**question**: Ask the user a question with optional choices and wait for the answer",
    parameters: params,
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      const info: WebUiQuestionInfo = {
        question: p.question,
        header: p.header,
        options: p.options ?? [],
        multiple: p.multiple === true,
      };

      // TUI モード: ネイティブ UI。multiple は単一選択に縮退（TUI 制約）。
      if (ctx.hasUI) {
        let answer: string | null | undefined;
        if (info.options.length > 0) {
          answer = await ctx.ui.select(info.header ?? info.question, info.options.map((o) => o.label));
        } else {
          answer = await ctx.ui.input(info.header ?? info.question, info.question);
        }
        const text =
          answer && answer.trim().length > 0
            ? `ユーザーの回答: ${answer.trim()}`
            : "ユーザーは回答せずキャンセルしました。自分で判断して進めてください。";
        return { content: [{ type: "text", text }], details: { canceled: !answer } };
      }

      // WebUI モード: ブラウザの QuestionCard で回答を待つ。
      const result = await requestWebUiQuestion({
        sessionId: extensionSessionId(ctx),
        questions: [info],
      });
      if (!result || result.answers.length === 0 || result.answers[0].length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "ユーザーは時間切れまたはキャンセルで回答しませんでした。最も妥当な判断で先へ進んでください。",
            },
          ],
          details: { answered: false },
        };
      }
      const answers = result.answers[0].join("、");
      return {
        content: [{ type: "text", text: `ユーザーの回答: ${answers}` }],
        details: { answered: true, answers: result.answers },
      };
    },
  });
}
