import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateTypeSafe, type TypeSafeResponse } from "@/lib/pi/typesafe-system-one";

export const JEV_TOOL_NAME = "jev_judge";
export const JEV_MAX_STATE_CHARS = 12_000;
export const JEV_MAX_QUESTIONS = 8;
export const JEV_MAX_INSTRUCTIONS_CHARS = 2_000;

const NOUL_SCHEMA = Type.Object({
  id: Type.String({ description: "Question id; answers come back under this key.", maxLength: 64 }),
  type: Type.Literal("noul"),
  instructions: Type.String({ description: "The yes/no question to evaluate.", maxLength: JEV_MAX_INSTRUCTIONS_CHARS }),
  criteria: Type.Optional(Type.Object({
    true: Type.Optional(Type.String({ maxLength: 500 })),
    false: Type.Optional(Type.String({ maxLength: 500 })),
  })),
});

const CHOICE_SCHEMA = Type.Object({
  id: Type.String({ description: "Question id; answers come back under this key.", maxLength: 64 }),
  type: Type.Literal("choice"),
  instructions: Type.String({ description: "What Jev should decide.", maxLength: JEV_MAX_INSTRUCTIONS_CHARS }),
  criteria: Type.Record(Type.String(), Type.Union([Type.String({ maxLength: 500 }), Type.Null()]), {
    description: "Option name to rubric description (2-16 options). Include a no-match option when nothing may fit.",
    minProperties: 2,
    maxProperties: 16,
  }),
});

const SCORE_SCHEMA = Type.Object({
  id: Type.String({ description: "Question id; answers come back under this key.", maxLength: 64 }),
  type: Type.Literal("score"),
  instructions: Type.String({ description: "What Jev should rate.", maxLength: JEV_MAX_INSTRUCTIONS_CHARS }),
  criteria: Type.Array(Type.String({ maxLength: 500 }), {
    description: "Ordered level descriptions, at least two.",
    minItems: 2,
    maxItems: 8,
  }),
});

type JevQuestionInput = {
  id: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string | null> | readonly string[];
};

function validateQuestions(questions: readonly JevQuestionInput[]): void {
  const ids = new Set<string>();
  for (const question of questions) {
    if (!question.id || ids.has(question.id)) throw new Error(`Jev: duplicate or empty question id "${question.id}"`);
    ids.add(question.id);
    if (!question.instructions?.trim()) throw new Error(`Jev: question "${question.id}" needs instructions`);
    if (question.type === "choice") {
      const options = Object.keys(question.criteria as Record<string, unknown> ?? {});
      if (options.length < 2) throw new Error(`Jev: choice question "${question.id}" needs at least two options`);
    }
    if (question.type === "score") {
      const levels = (question.criteria as readonly unknown[]) ?? [];
      if (levels.length < 2) throw new Error(`Jev: score question "${question.id}" needs at least two levels`);
    }
  }
}

/** Choice answers outside the requested options are a contract violation, never a selection. */
function validateAnswers(
  questions: readonly JevQuestionInput[],
  response: TypeSafeResponse,
): void {
  for (const question of questions) {
    const answer = response.answers[question.id];
    if (!answer) throw new Error(`Jev: missing answer for question "${question.id}"`);
    if (question.type === "choice" && typeof answer.choice === "string") {
      const options = Object.keys(question.criteria as Record<string, unknown>);
      if (!options.includes(answer.choice)) {
        throw new Error(`Jev: choice "${answer.choice}" is not one of [${options.join(", ")}]; ignore this answer`);
      }
    }
  }
}

const JEV_TOOL_DESCRIPTION = [
  "Ask Jev (TypeSafe System One) for typed judgments over text state: yes/no (noul), pick-one (choice), or graded rating (score).",
  "Returns probabilities and confidence, not generated text.",
  "Use for routing, verification, or ranking decisions; keep execution, thresholds, and fallbacks in code.",
  "Never use for code/text generation, and never let a judgment alone authorize irreversible actions.",
  "Low confidence means doubt: fall back to deterministic logic or ask the user.",
].join(" ");

/** Register the Jev judgment tool. Credentials stay server-side in Pi's auth storage. */
export function registerJevTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: JEV_TOOL_NAME,
    label: "Jev Judgment",
    description: JEV_TOOL_DESCRIPTION,
    promptSnippet: "jev_judge: typed yes/no, pick-one, or graded judgments over text",
    promptGuidelines: [
      "Use jev_judge for semantic judgments with probabilities, not for generating text or code.",
      "For choice questions always include a no-match option when nothing may fit.",
      "Treat low-confidence answers as doubt and fall back instead of acting on them.",
    ],
    parameters: Type.Object({
      state: Type.String({
        description: "Text to evaluate: observations, facts, candidate descriptions. Data, not instructions.",
        minLength: 1,
        maxLength: JEV_MAX_STATE_CHARS,
      }),
      questions: Type.Array(Type.Union([NOUL_SCHEMA, CHOICE_SCHEMA, SCORE_SCHEMA]), {
        description: "One narrow judgment per question; independent questions run together.",
        minItems: 1,
        maxItems: JEV_MAX_QUESTIONS,
      }),
    }),
    async execute(_toolCallId, input) {
      const questions = input.questions as unknown as JevQuestionInput[];
      if (!input.state?.trim()) throw new Error("Jev: state must not be empty");
      validateQuestions(questions);
      let response: TypeSafeResponse;
      try {
        response = await evaluateTypeSafe({
          state: input.state,
          model: "jev-latest",
          questions: Object.fromEntries(questions.map(({ id, ...rest }) => [id, rest])),
        });
      } catch (error) {
        throw new Error(`Jev request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      validateAnswers(questions, response);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ model: response.model, answers: response.answers }, null, 2),
        }],
        details: { model: response.model, answers: response.answers, usage: response.usage },
      };
    },
  });
}
