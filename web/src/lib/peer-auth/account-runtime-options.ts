import { createRemotePeerCredentialStore } from "@backend-core/peer-auth-remote-store.mjs";
import { readPeerConfig } from "@backend-core/peer-auth-config.mjs";
import { accountAuthPath, accountDir, accountModelsStorePath } from "@/lib/accounts";

/**
 * Options for an account's ModelRuntime. An account with a valid `peer.json` takes its credentials from
 * another LCP through a read-only, in-memory store and has no auth.json of its own; every other account
 * keeps its file-backed auth. (docs/plans/peer-auth-share.md)
 */
export function accountRuntimeOptions(id: string, agentDir: string) {
  const common = {
    modelsStorePath: accountModelsStorePath(id, agentDir),
    allowModelNetwork: true,
    modelRefreshTimeoutMs: 8_000,
  };
  const peer = readPeerConfig(accountDir(id, agentDir));
  if (!peer) return { authPath: accountAuthPath(id, agentDir), ...common };
  return {
    credentials: createRemotePeerCredentialStore({ peerUrl: peer.peerUrl, token: peer.token, accountId: peer.peerAccountId }),
    ...common,
  };
}
