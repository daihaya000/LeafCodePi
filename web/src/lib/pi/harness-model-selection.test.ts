import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { taskMatchesRequestedModel } from "./harness";
import type { TaskSummary } from "@/lib/types";

type RouteFields = Pick<
  TaskSummary,
  "providerID" | "modelID" | "accountId" | "accountIdExplicit"
>;

const task: RouteFields = {
  providerID: "anthropic",
  modelID: "claude-sonnet",
};

describe("taskMatchesRequestedModel", () => {
  it("skips re-resolution only when provider and model already match", () => {
    assert.equal(
      taskMatchesRequestedModel(task, { providerID: "anthropic", modelID: "claude-sonnet" }, false),
      true,
    );
    assert.equal(
      taskMatchesRequestedModel(task, { providerID: "anthropic", modelID: "claude-opus" }, false),
      false,
    );
    assert.equal(
      taskMatchesRequestedModel(task, { providerID: "openai-codex", modelID: "claude-sonnet" }, false),
      false,
    );
    assert.equal(taskMatchesRequestedModel(task, null, false), false);
  });

  it("requires the same account only when the request pins one", () => {
    const pinned: RouteFields = { ...task, accountId: "acc-1", accountIdExplicit: true };
    assert.equal(
      taskMatchesRequestedModel(
        pinned,
        { providerID: "anthropic", modelID: "claude-sonnet", accountId: "acc-1" },
        true,
      ),
      true,
    );
    assert.equal(
      taskMatchesRequestedModel(
        pinned,
        { providerID: "anthropic", modelID: "claude-sonnet", accountId: "acc-2" },
        true,
      ),
      false,
    );
    // An unpinned request still matches a task bound to some account...
    assert.equal(
      taskMatchesRequestedModel(
        { ...task, accountId: "acc-1" },
        { providerID: "anthropic", modelID: "claude-sonnet" },
        false,
      ),
      true,
    );
    // ...but switching the explicit flag must re-resolve the route.
    assert.equal(
      taskMatchesRequestedModel(
        pinned,
        { providerID: "anthropic", modelID: "claude-sonnet", accountId: "acc-1" },
        false,
      ),
      false,
    );
  });
});
