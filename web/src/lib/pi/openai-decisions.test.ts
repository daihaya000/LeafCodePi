import { describe, expect, it } from "vitest";
import { fromDecisionsResponse, toDecisionsRequest } from "./openai-decisions";
import type { TypeSafeRequest } from "./typesafe-system-one";

const request: TypeSafeRequest = {
  state: { ticket: "Cannot pay" },
  questions: {
    urgent: { type: "noul", instructions: "Is it urgent?", criteria: { true: "Time-sensitive", false: "Can wait" } },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payment issues", none: null } },
    severity: { type: "score", instructions: "How severe?", criteria: ["Cosmetic", "Blocked"] },
  },
};
const response = {
  model: "gpt-6-luna",
  answers: [
    { type: "predicate", name: "urgent", probability: 0.9 },
    { type: "choice", name: "team", choice: "billing", confidence: 0.8,
      probabilities: [{ value: "billing", probability: 0.9 }, { value: "none", probability: 0.1 }] },
    { type: "score", name: "severity", score: 0.7, confidence: 0.4,
      probabilities: [{ value: 0, label: "0", probability: 0.3 }, { value: 1, label: "1", probability: 0.7 }] },
  ],
  usage: { input_tokens: 42, output_tokens: 0 },
};

describe("OpenAI Decisions / Jev conversion", () => {
  it("maps state, names, predicates, null choice criteria and ordered score levels", () => {
    expect(toDecisionsRequest(request, "gpt-6-luna")).toEqual({
      model: "gpt-6-luna", input: '{"ticket":"Cannot pay"}', questions: [
        { type: "predicate", name: "urgent", instructions: "Is it urgent?\n\nCriteria:\ntrue: Time-sensitive\nfalse: Can wait" },
        { type: "choice", name: "team", instructions: "Which team?", choices: [
          { value: "billing", description: "Payment issues" }, { value: "none", description: "none" },
        ] },
        { type: "score", name: "severity", instructions: "How severe?", levels: [
          { label: "0", description: "Cosmetic" }, { label: "1", description: "Blocked" },
        ] },
      ],
    });
    expect(toDecisionsRequest({ state: "unchanged text", questions: { yes: { type: "noul", instructions: "Yes?" } } }, "gpt-6-luna"))
      .toMatchObject({ input: "unchanged text", questions: [{ type: "predicate", name: "yes", instructions: "Yes?" }] });
  });

  it("maps unordered answers by name and preserves probabilities, confidence, score and usage", () => {
    expect(fromDecisionsResponse({ ...response, answers: [...response.answers].reverse() }, request)).toEqual({
      model: "gpt-6-luna", usage: response.usage,
      answers: {
        urgent: { type: "noul", noul: 0.9 },
        team: { type: "choice", choice: "billing", confidence: 0.8, probabilities: { billing: 0.9, none: 0.1 } },
        severity: { type: "score", score: 0.7, confidence: 0.4, probabilities: { "0": 0.3, "1": 0.7 }, legend: { "0": "Cosmetic", "1": "Blocked" } },
      },
    });
  });

  it.each([
    null,
    { ...response, answers: {} },
    { ...response, answers: response.answers.slice(1) },
    { ...response, answers: [response.answers[0], response.answers[0], response.answers[2]] },
    { ...response, answers: [{ ...response.answers[0], name: "unknown" }, ...response.answers.slice(1)] },
    { ...response, answers: [{ ...response.answers[0], type: "noul" }, ...response.answers.slice(1)] },
  ])("rejects missing, duplicate, unknown or mismatched answers", (body) => {
    expect(() => fromDecisionsResponse(body, request)).toThrow("invalid judgment");
  });

  it("rejects refusals rather than converting them to a zero or low-confidence answer", () => {
    expect(() => fromDecisionsResponse({ ...response, answers: [
      { type: "refusal", name: "urgent" }, ...response.answers.slice(1),
    ] }, request)).toThrow("refused");
  });

  it.each([
    undefined,
    [{ value: "billing", probability: 1 }],
    [{ value: "billing", probability: 0.9 }, { value: "billing", probability: 0.1 }],
    [{ value: "billing", probability: 0.9 }, { value: "unknown", probability: 0.1 }],
    [{ value: "billing", probability: 0.9 }, { value: "none", probability: -0.1 }],
    [{ value: "billing", probability: 0.9 }, { value: "none", probability: "0.1" }],
    [{ value: "billing", probability: 0.9 }, { value: "none", probability: 0.5 }],
    [{ value: true, probability: 0.9 }, { value: false, probability: 0.1 }],
  ])("rejects malformed choice distributions", (probabilities) => {
    expect(() => fromDecisionsResponse({ ...response, answers: [
      response.answers[0], { ...response.answers[1], probabilities }, response.answers[2],
    ] }, request)).toThrow("invalid judgment");
  });

  it("requires numeric score indices and safely handles special object keys", () => {
    expect(() => fromDecisionsResponse({ ...response, answers: [
      ...response.answers.slice(0, 2), { ...response.answers[2], probabilities: [
        { value: "0", probability: 0.3 }, { value: "1", probability: 0.7 },
      ] },
    ] }, request)).toThrow("invalid judgment");
    const specialRequest: TypeSafeRequest = { state: "test", questions: Object.fromEntries([
      ["__proto__", { type: "choice", instructions: "Which?", criteria: Object.fromEntries([["__proto__", null], ["none", null]]) }],
    ]) };
    const specialResponse = fromDecisionsResponse({ model: "gpt-6-luna", usage: response.usage, answers: [
      { type: "choice", name: "__proto__", choice: "__proto__", confidence: 1, probabilities: [
        { value: "__proto__", probability: 1 }, { value: "none", probability: 0 },
      ] },
    ] }, specialRequest) as { answers: Record<string, { probabilities: Record<string, number> }> };
    expect(Object.hasOwn(specialResponse.answers, "__proto__")).toBe(true);
    expect(Object.hasOwn(specialResponse.answers.__proto__.probabilities, "__proto__")).toBe(true);
  });
});
