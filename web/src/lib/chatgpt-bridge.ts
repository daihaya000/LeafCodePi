export const CHATGPT_BRIDGE_STATES = [
  "disabled",
  "prerequisites_missing",
  "ready",
  "starting",
  "pairing",
  "connected",
  "verified",
  "repair_needed",
  "busy",
  "error",
] as const;

export type ChatGptBridgeState = (typeof CHATGPT_BRIDGE_STATES)[number];
export type ChatGptBridgeAction =
  | "setup"
  | "start"
  | "pair"
  | "verify"
  | "stop"
  | "disconnect"
  | "enabled";

export interface ChatGptBridgeStatus {
  ok: boolean;
  enabled: boolean;
  artifactReady: boolean;
  cloudflaredAvailable: boolean;
  state: ChatGptBridgeState;
  projectId: string | null;
  projectName?: string;
  connected?: boolean;
  verified?: boolean;
  verifiedAt?: string | null;
  publicUrl?: string | null;
  connectionUrl?: string | null;
  tunnelRunning?: boolean;
  pairingActive?: boolean;
  error?: string;
}

export interface ChatGptBridgePairing {
  ok: true;
  projectId: string;
  connectionUrl: string;
  pairingCode: string;
  pairingExpiresAt: number;
}

export function isSafeChatGptProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

export function chatGptBridgePath(action: ChatGptBridgeAction): string {
  return `/chatgpt-bridge/${action}`;
}
