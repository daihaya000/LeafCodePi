import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODELS_CACHE_MAX_AGE_MS,
  MODELS_CACHE_STORAGE_KEY,
  clearCachedModels,
  readCachedModels,
  writeCachedModels,
} from "./models-cache";
import type { ModelOption } from "@/lib/types";

class MemorySessionStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const models: ModelOption[] = [
  {
    value: "provider::model-a",
    label: "Model A",
    providerID: "provider",
    modelID: "model-a",
  },
];

beforeEach(() => {
  (globalThis as unknown as { sessionStorage?: MemorySessionStorage }).sessionStorage =
    new MemorySessionStorage();
  clearCachedModels();
});

afterEach(() => {
  clearCachedModels();
  delete (globalThis as unknown as { sessionStorage?: MemorySessionStorage }).sessionStorage;
  vi.useRealTimers();
});

describe("models-cache", () => {
  it("round-trips a non-empty model list through memory and sessionStorage", () => {
    expect(writeCachedModels(models, 1_000)).toBe(true);
    expect(readCachedModels(1_000)).toEqual(models);
    expect(sessionStorage.getItem(MODELS_CACHE_STORAGE_KEY)).toContain("provider::model-a");
  });

  it("refuses to cache an empty list so loading stays visible", () => {
    expect(writeCachedModels([], 1_000)).toBe(false);
    expect(readCachedModels(1_000)).toBeNull();
  });

  it("expires after MODELS_CACHE_MAX_AGE_MS", () => {
    expect(writeCachedModels(models, 1_000)).toBe(true);
    expect(readCachedModels(1_000 + MODELS_CACHE_MAX_AGE_MS - 1)).toEqual(models);
    expect(readCachedModels(1_000 + MODELS_CACHE_MAX_AGE_MS)).toBeNull();
  });

  it("ignores malformed payloads instead of throwing", () => {
    sessionStorage.setItem(MODELS_CACHE_STORAGE_KEY, "{not json");
    expect(readCachedModels(1_000)).toBeNull();
    sessionStorage.setItem(
      MODELS_CACHE_STORAGE_KEY,
      JSON.stringify({ version: 1, at: 1_000, models: [{ value: "x" }] }),
    );
    expect(readCachedModels(1_000)).toBeNull();
  });
});
