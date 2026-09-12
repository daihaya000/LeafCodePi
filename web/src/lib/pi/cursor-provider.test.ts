import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { registerCursorProvider } from "./cursor-provider";

const require = createRequire(import.meta.url);

describe("registerCursorProvider", () => {
  it("loads a wire-compatible Cursor extension in the Node host", async () => {
    const packageJson = JSON.parse(
      readFileSync(
        require.resolve("@rahularya01/pi-cursor/package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    if (typeof packageJson.version !== "string") {
      throw new Error("pi-cursor package version is missing");
    }
    const [major, minor, patch] = packageJson.version.split(".").map(Number);
    expect(
      major > 1 ||
        (major === 1 &&
          (minor > 4 || (minor === 4 && Number.isFinite(patch) && patch >= 30))),
    ).toBe(true);

    const registerProvider = vi.fn();
    await registerCursorProvider({
      getProvider: () => undefined,
      registerProvider,
      registerNativeProvider: vi.fn(),
    } as never);

    expect(registerProvider).toHaveBeenCalledWith(
      "cursor",
      expect.objectContaining({
        streamSimple: expect.any(Function),
        refreshModels: expect.any(Function),
      }),
    );
  }, 15_000);
});
