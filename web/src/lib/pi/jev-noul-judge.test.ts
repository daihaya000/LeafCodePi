import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_NOUL_JUDGE_KEY as EXTENSION_KEY } from "../../../../extensions/leafcode-todowrite/jev-bridge";
import { createJevNoulJudge, JEV_NOUL_JUDGE_KEY, registerJevNoulJudge } from "./jev-noul-judge";
import type { TypeSafeResponse } from "./typesafe-system-one";

const request = {
  state: { userRequest: "この関数は何をしているの？" },
  questions: {
    needsList: {
      instructions: "Would a careful engineer keep a written ToDo list for userRequest?",
      criteria: { true: "Multi-step work.", false: "A question." },
    },
    dependsOnContext: { instructions: "Does userRequest depend on earlier conversation?" },
  },
};

const response = (answers: TypeSafeResponse["answers"]): TypeSafeResponse => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 1, output_tokens: 1 },
});

const complete = () => response({
  needsList: { type: "noul", noul: 0.07 },
  dependsOnContext: { type: "noul", noul: 0.1 },
});

type Evaluate = NonNullable<Parameters<typeof createJevNoulJudge>[0]["evaluate"]>;
const evaluator = (answer: TypeSafeResponse | Error) =>
  vi.fn<Evaluate>(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });

afterEach(() => {
  registerJevNoulJudge(null);
});

describe("createJevNoulJudge", () => {
  it("asks every question as a noul in one request and returns the probabilities", async () => {
    const evaluate = evaluator(complete());
    const signal = new AbortController().signal;
    const judge = createJevNoulJudge({ isUsable: async () => true, evaluate });

    expect(await judge({ ...request, signal })).toEqual({ needsList: 0.07, dependsOnContext: 0.1 });
    expect(evaluate).toHaveBeenCalledOnce();
    const [sent, options] = evaluate.mock.calls[0]!;
    expect(sent).toEqual({
      state: request.state,
      questions: {
        needsList: { type: "noul", ...request.questions.needsList },
        dependsOnContext: { type: "noul", instructions: request.questions.dependsOnContext.instructions },
      },
    });
    // No criteria key at all when the caller gave none.
    expect(Object.hasOwn(sent.questions.dependsOnContext!, "criteria")).toBe(false);
    expect(options).toEqual({ signal });
  });

  it("is null without calling Jev when no Jev model is usable", async () => {
    const evaluate = evaluator(complete());
    const judge = createJevNoulJudge({ isUsable: async () => false, evaluate });

    expect(await judge(request)).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("is null when the usability check itself fails", async () => {
    const evaluate = evaluator(complete());
    const judge = createJevNoulJudge({ isUsable: async () => { throw new Error("catalog unreadable"); }, evaluate });

    expect(await judge(request)).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("does not call Jev when there is nothing to ask", async () => {
    const evaluate = evaluator(complete());
    const judge = createJevNoulJudge({ isUsable: async () => true, evaluate });

    expect(await judge({ state: request.state, questions: {} })).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("does not call Jev for an already aborted request or one aborted during the usability check", async () => {
    const evaluate = evaluator(complete());
    const aborted = new AbortController();
    aborted.abort();
    const judge = createJevNoulJudge({ isUsable: async () => true, evaluate });
    expect(await judge({ ...request, signal: aborted.signal })).toBeNull();

    const late = new AbortController();
    const lateJudge = createJevNoulJudge({
      isUsable: async () => { late.abort(); return true; },
      evaluate,
    });
    expect(await lateJudge({ ...request, signal: late.signal })).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("is null when the request fails", async () => {
    const judge = createJevNoulJudge({
      isUsable: async () => true,
      evaluate: evaluator(new Error("Jev API error: 500")),
    });
    expect(await judge(request)).toBeNull();
  });

  it("is null unless every question came back as a numeric noul", async () => {
    for (const answers of [
      {},
      { needsList: { type: "noul", noul: 0.07 } },
      { dependsOnContext: { type: "noul", noul: 0.1 } },
      { needsList: { type: "noul", noul: 0.07 }, dependsOnContext: { type: "score", score: 1, confidence: 0.9 } },
      { needsList: { type: "noul", noul: 0.07 }, dependsOnContext: { type: "noul" } },
      { needsList: { type: "noul", noul: "0.07" }, dependsOnContext: { type: "noul", noul: 0.1 } },
    ] as unknown as TypeSafeResponse["answers"][]) {
      const judge = createJevNoulJudge({ isUsable: async () => true, evaluate: evaluator(response(answers)) });
      expect(await judge(request), JSON.stringify(answers)).toBeNull();
    }
  });
});

describe("registerJevNoulJudge", () => {
  const host = globalThis as typeof globalThis & { [JEV_NOUL_JUDGE_KEY]?: unknown };

  it("publishes the judge under the key the extension reads, and clears it with null", () => {
    expect(JEV_NOUL_JUDGE_KEY).toBe(EXTENSION_KEY);
    const judge = createJevNoulJudge({ isUsable: async () => false });

    registerJevNoulJudge(judge);
    expect(host[JEV_NOUL_JUDGE_KEY]).toBe(judge);
    registerJevNoulJudge(null);
    expect(host[JEV_NOUL_JUDGE_KEY]).toBeNull();
  });
});
