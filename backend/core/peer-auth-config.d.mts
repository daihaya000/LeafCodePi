import type { PeerConfig } from "../../shared/ui-owner-dtos";
export type { PeerConfig } from "../../shared/ui-owner-dtos";
export type PeerConfigInput = Omit<PeerConfig, "version" | "createdAt"> & { version?: 1; createdAt?: string };
export function peerConfigPath(accountDir: string): string;
export function normalizePeerUrl(value: unknown): string | null;
export function parsePeerConfig(value: unknown): PeerConfig | null;
export function readPeerConfig(accountDir: string): PeerConfig | null;
export function writePeerConfig(accountDir: string, config: PeerConfigInput, now?: () => Date): PeerConfig;
export function removePeerConfig(accountDir: string): void;
