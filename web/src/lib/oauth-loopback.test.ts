import { describe, expect, it } from "vitest";
import {
  CLAUDE_OAUTH_CALLBACK_HOST,
  CODEX_OAUTH_CALLBACK_HOST,
  REMOTE_OAUTH_HINT,
  REMOTE_OAUTH_SSH_FORWARD,
} from "./oauth-loopback";

describe("remote OAuth loopback docs", () => {
  it("keeps optional SSH ports but documents remote URL paste and device codes", () => {
    expect(CLAUDE_OAUTH_CALLBACK_HOST).toBe("127.0.0.1:53692");
    expect(CODEX_OAUTH_CALLBACK_HOST).toBe("localhost:1455");
    expect(REMOTE_OAUTH_SSH_FORWARD).toBe(
      "ssh -N -L 53692:127.0.0.1:53692 -L 1455:127.0.0.1:1455 user@host",
    );
    expect(REMOTE_OAUTH_HINT).toContain("戻り先URL全体");
    expect(REMOTE_OAUTH_HINT).toContain("接続エラーだけでは認証失敗ではありません");
    expect(REMOTE_OAUTH_HINT).not.toContain("ssh -N");
    expect(REMOTE_OAUTH_HINT).toContain("デバイスコード");
  });
});
