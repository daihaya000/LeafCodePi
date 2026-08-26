import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  __resetCommandCodeProviderCacheForTests,
  downgradeUnsupportedImages,
  registerCommandCodeProvider,
  resolveCommandCodeExtensionEntry,
  syncCommandCodeApiKeyEnv,
  withImageDowngrade,
} from "./commandcode-provider";

describe("syncCommandCodeApiKeyEnv", () => {
  const prevPrimary = process.env.COMMANDCODE_API_KEY;
  const prevAlt = process.env.COMMAND_CODE_API_KEY;

  afterEach(() => {
    if (prevPrimary === undefined) delete process.env.COMMANDCODE_API_KEY;
    else process.env.COMMANDCODE_API_KEY = prevPrimary;
    if (prevAlt === undefined) delete process.env.COMMAND_CODE_API_KEY;
    else process.env.COMMAND_CODE_API_KEY = prevAlt;
  });

  it("copies COMMAND_CODE_API_KEY when COMMANDCODE_API_KEY is unset", () => {
    delete process.env.COMMANDCODE_API_KEY;
    process.env.COMMAND_CODE_API_KEY = "user_from_alt";
    syncCommandCodeApiKeyEnv();
    assert.equal(process.env.COMMANDCODE_API_KEY, "user_from_alt");
  });

  it("does not overwrite an existing COMMANDCODE_API_KEY", () => {
    process.env.COMMANDCODE_API_KEY = "user_primary";
    process.env.COMMAND_CODE_API_KEY = "user_alt";
    syncCommandCodeApiKeyEnv();
    assert.equal(process.env.COMMANDCODE_API_KEY, "user_primary");
  });
});

describe("registerCommandCodeProvider", () => {
  const previousFetch = globalThis.fetch;
  const previousModelsUrl = process.env.COMMANDCODE_MODELS_URL;
  const previousModelsCache = process.env.COMMANDCODE_MODELS_CACHE;
  const tempDirs: string[] = [];

  afterEach(() => {
    __resetCommandCodeProviderCacheForTests();
    globalThis.fetch = previousFetch;
    if (previousModelsUrl === undefined) delete process.env.COMMANDCODE_MODELS_URL;
    else process.env.COMMANDCODE_MODELS_URL = previousModelsUrl;
    if (previousModelsCache === undefined) delete process.env.COMMANDCODE_MODELS_CACHE;
    else process.env.COMMANDCODE_MODELS_CACHE = previousModelsCache;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("loads one catalog for concurrent registrations and registers each runtime once", async () => {
    __resetCommandCodeProviderCacheForTests();
    const dir = mkdtempSync(join(tmpdir(), "leafcode-commandcode-"));
    tempDirs.push(dir);
    process.env.COMMANDCODE_MODELS_URL = "https://commandcode.test/models";
    process.env.COMMANDCODE_MODELS_CACHE = join(dir, "models.json");
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "test-model", name: "Test Model", context_length: 32_000 }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    function fakeRuntime() {
      let configured = false;
      let registrations = 0;
      return {
        runtime: {
          getProvider: (id: string) => id === "commandcode" && configured ? { id } : undefined,
          registerProvider: (id: string) => {
            if (id === "commandcode") {
              configured = true;
              registrations += 1;
            }
          },
          registerNativeProvider: () => {},
        } as never,
        registrations: () => registrations,
      };
    }

    const first = fakeRuntime();
    const second = fakeRuntime();
    await Promise.all([
      registerCommandCodeProvider(first.runtime),
      registerCommandCodeProvider(first.runtime),
      registerCommandCodeProvider(second.runtime),
    ]);

    assert.equal(fetches, 1);
    assert.equal(first.registrations(), 1);
    assert.equal(second.registrations(), 1);
  });
});

describe("downgradeUnsupportedImages", () => {
  const toolResult = {
    role: "toolResult",
    content: [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "iVBORw0K", mimeType: "image/png" },
    ],
  };

  it("replaces tool result images with a placeholder for text-only models", () => {
    const result = downgradeUnsupportedImages({ input: ["text"] }, { messages: [toolResult] });
    assert.deepEqual(result.messages, [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "text", text: "(tool image omitted: model does not support images)" },
        ],
      },
    ]);
  });

  it("uses the user placeholder for user messages", () => {
    const result = downgradeUnsupportedImages(
      { input: ["text"] },
      { messages: [{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }] },
    );
    assert.deepEqual(result.messages, [
      {
        role: "user",
        content: [{ type: "text", text: "(image omitted: model does not support images)" }],
      },
    ]);
  });

  it("collapses consecutive images into one placeholder", () => {
    const result = downgradeUnsupportedImages(
      { input: ["text"] },
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", data: "a", mimeType: "image/png" },
              { type: "image", data: "b", mimeType: "image/png" },
            ],
          },
        ],
      },
    );
    assert.deepEqual(result.messages, [
      {
        role: "user",
        content: [{ type: "text", text: "(image omitted: model does not support images)" }],
      },
    ]);
  });

  it("leaves the context untouched for vision models", () => {
    const context = { messages: [toolResult] };
    assert.equal(downgradeUnsupportedImages({ input: ["text", "image"] }, context), context);
  });

  it("returns the same context when there is no image to strip", () => {
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    assert.equal(downgradeUnsupportedImages({ input: ["text"] }, context), context);
  });

  it("tolerates a missing model and non-array content", () => {
    const context = { messages: [{ role: "user", content: "plain" }] };
    assert.equal(downgradeUnsupportedImages(undefined, context), context);
  });
});

describe("withImageDowngrade", () => {
  it("downgrades images before delegating to the extension stream", () => {
    const seen: unknown[] = [];
    const config = withImageDowngrade({
      name: "Command Code",
      streamSimple: (_model: unknown, context: unknown) => {
        seen.push(context);
        return "stream";
      },
    });
    const streamSimple = config.streamSimple as (m: unknown, c: unknown) => unknown;
    const returned = streamSimple(
      { input: ["text"] },
      { messages: [{ role: "toolResult", content: [{ type: "image", data: "x", mimeType: "image/png" }] }] },
    );
    assert.equal(returned, "stream");
    assert.deepEqual(seen, [
      {
        messages: [
          {
            role: "toolResult",
            content: [{ type: "text", text: "(tool image omitted: model does not support images)" }],
          },
        ],
      },
    ]);
  });

  it("passes the config through when there is no streamSimple", () => {
    const config = { name: "Command Code" };
    assert.equal(withImageDowngrade(config), config);
  });
});

describe("resolveCommandCodeExtensionEntry", () => {
  it("finds the installed package index.ts from cwd", () => {
    const entry = resolveCommandCodeExtensionEntry();
    assert.ok(entry);
    assert.match(entry.replace(/\\/g, "/"), /pi-commandcode-provider\/index\.ts$/);
  });
});
