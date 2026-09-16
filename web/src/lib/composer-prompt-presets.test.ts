// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getJson: vi.fn(),
}));

vi.mock("@/lib/client", () => client);

import {
  hasStoredComposerPromptPresets,
  readComposerPromptPresets,
  readComposerPromptPresetsFromServer,
} from "./composer-prompt-presets";

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  localStorage.clear();
});

describe("composer prompt preset sync", () => {
  it("does not treat malformed local data as a stored snapshot", () => {
    localStorage.setItem("leafcodepi.composerPromptPresets", "not-json");

    expect(hasStoredComposerPromptPresets()).toBe(false);
    expect(readComposerPromptPresets()).toEqual([]);
  });

  it("keeps invalid server data from overwriting the local snapshot", async () => {
    client.getJson.mockResolvedValue({ value: "not-json" });

    await expect(readComposerPromptPresetsFromServer()).resolves.toBeNull();
  });

  it("distinguishes an empty server snapshot from an invalid one", async () => {
    client.getJson.mockResolvedValue({ value: "[]" });

    await expect(readComposerPromptPresetsFromServer()).resolves.toEqual([]);
  });
});
