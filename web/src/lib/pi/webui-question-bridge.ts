import { randomUUID } from "node:crypto";
import type { QuestionRequestDto } from "@/lib/types";

export type WebUiQuestionAnswer = {
  /** 質問ごとの回答ラベル配列（自由入力含む）。 */
  answers: string[][];
};

/** Must match extensions/leafcode-question/webui-question-bridge.ts */
const GLOBAL_KEY = "__leafcodeWebUiQuestionHandler" as const;

type WebUiQuestionHandler = (
  request: Omit<QuestionRequestDto, "id"> & { id: string },
) => Promise<WebUiQuestionAnswer | null>;

function readHandler(): WebUiQuestionHandler | null {
  return (globalThis as typeof globalThis & { [GLOBAL_KEY]?: WebUiQuestionHandler | null })[GLOBAL_KEY] ?? null;
}

export function registerWebUiQuestionHandler(next: WebUiQuestionHandler | null): void {
  (globalThis as typeof globalThis & { [GLOBAL_KEY]?: WebUiQuestionHandler | null })[GLOBAL_KEY] = next;
}

/** Returns null when no WebUI handler is registered (caller should fall back). */
export async function requestWebUiQuestion(input: {
  sessionId: string;
  questions: QuestionRequestDto["questions"];
}): Promise<WebUiQuestionAnswer | null> {
  const handler = readHandler();
  if (!handler) return null;
  return handler({
    id: randomUUID(),
    sessionId: input.sessionId,
    questions: input.questions,
  });
}
