// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/client", () => ({
  getJson: vi.fn().mockResolvedValue({ value: null }),
  sendJson: vi.fn().mockResolvedValue(undefined),
}));

import {
  BUILTIN_COMPOSER_DEFAULTS,
  normalizeComposerDefaults,
  readComposerDefaults,
  writeComposerDefaults,
} from "./composer-defaults";

describe("composer defaults", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("falls back to builtin values for missing or invalid input", () => {
    expect(normalizeComposerDefaults(null)).toEqual(BUILTIN_COMPOSER_DEFAULTS);
    expect(normalizeComposerDefaults({ model: "  ", autoOptimize: "nope", agent: "" })).toEqual(
      BUILTIN_COMPOSER_DEFAULTS,
    );
    expect(readComposerDefaults()).toEqual(BUILTIN_COMPOSER_DEFAULTS);
  });

  it("round-trips a stored selection", () => {
    writeComposerDefaults({
      model: "openai::gpt-5",
      autoOptimize: "intelligence",
      agent: "build",
    });
    expect(readComposerDefaults()).toEqual({
      model: "openai::gpt-5",
      autoOptimize: "intelligence",
      agent: "build",
    });
  });
});
