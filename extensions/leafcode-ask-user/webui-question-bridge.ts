export type WebUiQuestionOption = {
  label: string;
  description?: string;
};

export type WebUiQuestionInfo = {
  question: string;
  header?: string;
  options: WebUiQuestionOption[];
  multiple?: boolean;
};

export type WebUiQuestionRequest = {
  id: string;
  sessionId: string;
  questions: WebUiQuestionInfo[];
};

export type WebUiQuestionAnswer = {
  /** 質問ごとの回答ラベル配列（自由入力含む）。 */
  answers: string[][];
};

/** Must match extensions/leafcode-ask-user/webui-question-bridge.ts */
const GLOBAL_KEY = "__leafcodeWebUiQuestionHandler" as const;

type WebUiQuestionHandler = (
  request: WebUiQuestionRequest,
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
  questions: WebUiQuestionInfo[];
}): Promise<WebUiQuestionAnswer | null> {
  const handler = readHandler();
  if (!handler) return null;
  return handler({
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    questions: input.questions,
  });
}
