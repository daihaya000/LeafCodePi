export type PeerGrant = {
  id: string;
  label: string;
  accountId: string | null;
  providers: string[];
  createdAt: string;
};
export type PeerGrantInput = { label: string; accountId?: string | null; providers: string[] };
export type PeerGrantStore = {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  list(): PeerGrant[];
  create(input: PeerGrantInput): { grant: PeerGrant; token: string };
  revoke(id: string): boolean;
  verify(token: unknown): PeerGrant | null;
};
export function peerAuthConfigPath(): string;
export function generatePeerToken(): string;
export function hashPeerToken(token: string): string;
export function createPeerGrantStore(options?: { path?: string; now?: () => Date }): PeerGrantStore;
