import { createQuestionBridge, type WebUiQuestionAnswer } from "@backend-core/webui-bridge.mjs";

export type { WebUiQuestionAnswer };

// Compatibility entrypoint. The process-global handler slot remains the shared
// contract with extensions/leafcode-question/webui-question-bridge.ts.
const bridge = createQuestionBridge();

export const registerWebUiQuestionHandler = bridge.registerWebUiQuestionHandler;
export const requestWebUiQuestion = bridge.requestWebUiQuestion;
