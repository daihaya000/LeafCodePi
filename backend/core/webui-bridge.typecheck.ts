import { createPermissionBridge, createQuestionBridge } from "./webui-bridge.mjs";

/** Compile-only checks for shared DTO wiring and handler result types. */
export function checkWebUiBridgeTypes(): void {
  const permissions = createPermissionBridge();
  const questions = createQuestionBridge();
  permissions.registerWebUiPermissionHandler(async (request) => request.command.length > 0);
  questions.registerWebUiQuestionHandler(async () => ({ answers: [["A"]] }));
  const decision: Promise<boolean | null> = permissions.requestWebUiPermission({
    sessionId: "session", command: "ls", labels: [], message: "allow?",
  });
  void decision;
  // @ts-expect-error Permission handlers return booleans or null.
  permissions.registerWebUiPermissionHandler(async () => "yes");
  // @ts-expect-error Question answers are label matrices.
  questions.registerWebUiQuestionHandler(async () => ({ answers: ["A"] }));
  // @ts-expect-error Permission commands remain strings.
  permissions.requestWebUiPermission({ sessionId: "session", command: 1, labels: [], message: "" });
}
