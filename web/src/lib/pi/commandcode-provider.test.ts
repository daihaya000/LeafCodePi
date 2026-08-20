import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { syncCommandCodeApiKeyEnv } from "./commandcode-provider";

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
