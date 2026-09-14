import { describe, expect, it } from "vitest";
import {
  CLAUDE_OAUTH_CALLBACK_HOST,
  CODEX_OAUTH_CALLBACK_HOST,
  REMOTE_OAUTH_HINT,
  REMOTE_OAUTH_SSH_FORWARD,
} from "./oauth-loopback";

describe("remote OAuth loopback docs", () => {
  it("keeps the designed callback ports and documents SSH forward", () => {
    expect(CLAUDE_OAUTH_CALLBACK_HOST).toBe("127.0.0.1:53692");
    expect(CODEX_OAUTH_CALLBACK_HOST).toBe("localhost:1455");
    expect(REMOTE_OAUTH_SSH_FORWARD).toBe(
      "ssh -N -L 53692:127.0.0.1:53692 -L 1455:127.0.0.1:1455 user@host",
    );
    expect(REMOTE_OAUTH_HINT).toContain(REMOTE_OAUTH_SSH_FORWARD);
    expect(REMOTE_OAUTH_HINT).toContain("デバイスコード");
  });
});
