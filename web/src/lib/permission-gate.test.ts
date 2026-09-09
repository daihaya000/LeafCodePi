import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PERMISSION_EVENT,
  PERMISSION_STORAGE_KEY,
  readPermissionMode,
  writePermissionMode,
} from "./permission-gate";

function stubStorage(getItem: ReturnType<typeof vi.fn>, setItem?: ReturnType<typeof vi.fn>) {
  // このモジュールは window.localStorage ではなくグローバルの localStorage を参照する
  vi.stubGlobal("localStorage", {
    getItem,
    setItem: setItem ?? vi.fn(),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("permission mode persistence", () => {
  it("defaults to allow when nothing is stored", () => {
    stubStorage(vi.fn(() => null));
    expect(readPermissionMode()).toBe("allow");
  });

  it("returns the stored mode", () => {
    stubStorage(
      vi.fn((key: string) => (key === PERMISSION_STORAGE_KEY ? "deny" : null)),
    );
    expect(readPermissionMode()).toBe("deny");
    stubStorage(vi.fn(() => "ask"));
    expect(readPermissionMode()).toBe("ask");
  });

  it("falls back to allow for invalid or corrupted values", () => {
    for (const raw of ["turbo", "{}", ""] as const) {
      stubStorage(vi.fn(() => raw));
      expect(readPermissionMode()).toBe("allow");
    }
  });

  it("returns allow when localStorage reads throw", () => {
    stubStorage(
      vi.fn(() => {
        throw new Error("storage blocked");
      }),
    );
    expect(readPermissionMode()).toBe("allow");
  });

  it("persists the mode and notifies listeners", () => {
    const setItem = vi.fn(() => undefined);
    const dispatchEvent = vi.fn();
    stubStorage(vi.fn(() => null), setItem);
    vi.stubGlobal("window", { dispatchEvent });
    writePermissionMode("ask");
    expect(setItem).toHaveBeenCalledWith(PERMISSION_STORAGE_KEY, "ask");
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: PERMISSION_EVENT, detail: "ask" }),
    );
  });

  it("does not throw when localStorage writes are blocked", () => {
    stubStorage(
      vi.fn(() => null),
      vi.fn(() => {
        throw new Error("quota exceeded");
      }),
    );
    expect(() => writePermissionMode("deny")).not.toThrow();
  });
});