import {
  createPermissionPromptService, createQuestionPromptService, PendingPromptIdCollisionError,
} from "./pending-prompts.mjs";

/** Compile-only checks: DTO imports must stay typed and decisions must not be swapped. */
export function checkPendingPromptTypes(): void {
  const permissions = createPermissionPromptService({
    resolveTaskId: () => "task", emit: () => undefined, snapshotExtras: () => ({}),
  });
  const questions = createQuestionPromptService({
    resolveTaskId: () => "task", emit: () => undefined, snapshotExtras: () => ({}),
  });
  const decision: Promise<boolean | null> = permissions.handleRequest({
    id: "id", sessionId: "session", command: "ls", labels: [], message: "allow?",
  });
  const answer: Promise<{ answers: string[][] } | null> = questions.handleRequest({
    id: "id", sessionId: "session", questions: [{ question: "Q", options: [{ label: "A" }] }],
  });
  void decision.catch((error: unknown) => {
    if (error instanceof PendingPromptIdCollisionError) {
      const code: "PENDING_PROMPT_ID_COLLISION" = error.code;
      void code;
    }
  });
  void answer;
  // @ts-expect-error Permission decisions are booleans.
  permissions.respond("task", "id", { answers: [] });
  // @ts-expect-error Question answers are string matrices or null.
  questions.respond("task", "id", true);
  // @ts-expect-error Permission commands remain shared DTO strings.
  permissions.handleRequest({ id: "id", sessionId: "session", command: 1, labels: [], message: "" });
}
