export type PeerConfig = {
  version: 1;
  peerUrl: string;
  peerAccountId: string | null;
  providers: string[];
  token: string;
  createdAt: string;
};
export type PeerConfigInput = Omit<PeerConfig, "version" | "createdAt"> & { version?: 1; createdAt?: string };
export function peerConfigPath(accountDir: string): string;
export function normalizePeerUrl(value: unknown): string | null;
export function parsePeerConfig(value: unknown): PeerConfig | null;
export function readPeerConfig(accountDir: string): PeerConfig | null;
export function writePeerConfig(accountDir: string, config: PeerConfigInput, now?: () => Date): PeerConfig;
export function removePeerConfig(accountDir: string): void;
