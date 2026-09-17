import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import {
  registerTypeSafeProvider,
  TYPESAFE_API_BASE_URL,
  TYPESAFE_API_KEY_ENV,
  TYPESAFE_PROVIDER_ID,
} from "./typesafe-provider";

describe("typesafe-provider", () => {
  it("registers TypeSafe as an API-key-only provider", () => {
    const registerProvider = vi.fn();

    registerTypeSafeProvider({
      getProvider: () => undefined,
      registerProvider,
    });

    assert.deepEqual(registerProvider.mock.calls[0], [
      TYPESAFE_PROVIDER_ID,
      {
        name: "TypeSafe",
        baseUrl: TYPESAFE_API_BASE_URL,
        apiKey: `$${TYPESAFE_API_KEY_ENV}`,
        models: [],
      },
    ]);
  });

  it("does not replace an existing registration", () => {
    const registerProvider = vi.fn();

    registerTypeSafeProvider({
      getProvider: (id) => (id === TYPESAFE_PROVIDER_ID ? {} : undefined),
      registerProvider,
    });

    assert.equal(registerProvider.mock.calls.length, 0);
  });
});
