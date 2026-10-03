export type RemotePeerCredential =
  | { type: "api_key"; key: string; env?: Record<string, string> }
  | { type: "oauth"; access: string; expires: number; refresh: "" };
type StoreOptions = { signal?: AbortSignal };
export type RemotePeerCredentialStore = {
  read(providerId: string, options?: StoreOptions): Promise<RemotePeerCredential | undefined>;
  list(options?: StoreOptions): Promise<{ providerId: string; type: "api_key" | "oauth" }[]>;
  listAccounts(options?: StoreOptions): Promise<{ accountId: string | null; label: string; providers: string[] }[]>;
  modify(
    providerId: string,
    fn: (current: RemotePeerCredential | undefined) => Promise<RemotePeerCredential | undefined>,
    options?: StoreOptions,
  ): Promise<RemotePeerCredential | undefined>;
  delete(providerId?: string, options?: StoreOptions): Promise<void>;
};
export function createRemotePeerCredentialStore(options: {
  peerUrl: string;
  token: string;
  accountId?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  refreshMarginMs?: number;
  apiKeyTtlMs?: number;
}): RemotePeerCredentialStore;
