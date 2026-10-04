import { describe, expect, it } from "vitest";
import { taskResponseModel } from "./task-response-model";

const previous = { providerID: "anthropic", modelID: "previous-model" };
const selected = { providerID: "openai-codex", modelID: "next-model" };

describe("taskResponseModel", () => {
  it("prefers the active route over the next selection and previous response", () => {
    const active = { providerID: "cursor", modelID: "active-model" };
    expect(taskResponseModel({ ...selected, responseModel: previous }, [], active)).toEqual(active);
  });

  it("uses the last assistant response, ignoring subsequent user and tool messages", () => {
    expect(taskResponseModel(selected, [
      { role: "assistant", provider: "cursor", model: "older-model" },
      { role: "assistant", provider: previous.providerID, model: previous.modelID },
      { role: "toolResult", provider: "cursor", model: "tool-model" },
      { role: "user" },
      null,
    ])).toEqual(previous);
  });

  it("retains the response model when an idle or cold task changes its next selection", () => {
    expect(taskResponseModel({ ...selected, responseModel: previous })).toEqual(previous);
  });

  it("falls back to the stored selection for legacy sessions", () => {
    expect(taskResponseModel(selected)).toEqual(selected);
    expect(taskResponseModel(selected, [{ role: "assistant", provider: 1, model: null }])).toEqual(selected);
  });

  it("does not invent missing provider or model information", () => {
    expect(taskResponseModel({})).toBeUndefined();
    expect(taskResponseModel({ providerID: "anthropic" })).toBeUndefined();
  });
});
