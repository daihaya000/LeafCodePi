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
  | "message"
  | "record"
  | "enabled";

export type ChatGptAdvisoryMessageKind = "init" | "executed";
export type ChatGptAdvisoryImportKind = "plan" | "review" | "done" | "blocked";
export type ChatGptExitStatus = "ok" | "failed" | "blocked";

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

export interface ChatGptAdvisoryMessage {
  ok: true;
  projectId: string;
  publicTaskId: string;
  iteration: number;
  kind: ChatGptAdvisoryMessageKind;
  message: string;
}

export interface ChatGptExecutionRecord {
  ok: true;
  projectId: string;
  publicTaskId: string;
  iteration: number;
  changedFiles: number;
  tests: string | null;
  exitStatus: ChatGptExitStatus;
}

export function isSafeChatGptProjectId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

export function isSafeChatGptPublicTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

export function isSafeChatGptIteration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}

export function chatGptBridgePath(action: ChatGptBridgeAction): string {
  return `/chatgpt-bridge/${action}`;
}
