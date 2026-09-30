import type { PermissionRequestDto, QuestionRequestDto } from "@shared/types";

export const WEBUI_PERMISSION_HANDLER_KEY: "__leafcodeWebUiPermissionHandler";
export const WEBUI_QUESTION_HANDLER_KEY: "__leafcodeWebUiQuestionHandler";

export type WebUiPermissionRequest = PermissionRequestDto;
export type WebUiPermissionHandler = (request: WebUiPermissionRequest) => Promise<boolean | null>;
export type WebUiQuestionAnswer = {
  /** Selected labels per question, including free-form answers. */
  answers: string[][];
};
export type WebUiQuestionHandler = (request: QuestionRequestDto) => Promise<WebUiQuestionAnswer | null>;

type BridgeOptions = { host?: object; uuid?: () => string };

export function createPermissionBridge(options?: BridgeOptions): {
  registerWebUiPermissionHandler: (next: WebUiPermissionHandler | null) => void;
  requestWebUiPermission: (input: Omit<WebUiPermissionRequest, "id">) => Promise<boolean | null>;
};

export function createQuestionBridge(options?: BridgeOptions): {
  registerWebUiQuestionHandler: (next: WebUiQuestionHandler | null) => void;
  requestWebUiQuestion: (input: Omit<QuestionRequestDto, "id">) => Promise<WebUiQuestionAnswer | null>;
};

/**
 * One prompt service per process, with the bridge handler registered on every call. The created
 * service must expose `handleRequest`; the caller's own service type is preserved.
 */
export function ensureGlobalPromptService<T>(options: {
  host: Record<string, unknown>;
  key: string;
  create: () => T;
  registerHandler: (handler: (request: unknown) => unknown) => void;
}): T;
