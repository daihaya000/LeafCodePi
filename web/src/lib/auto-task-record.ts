import {
  AUTO_MODEL_VALUE,
  DEFAULT_AUTO_OPTIMIZE_MODE,
  isAutoOptimizeMode,
  isAutoVariant,
  type AutoDecision,
} from "@/lib/auto-model";
import type { TaskStatus } from "@/lib/types";

export type AutoTaskRecord = {
  decision: AutoDecision;
  prompt?: string;
  agent?: string;
  retried?: boolean;
  dismissed?: boolean;
};

export const AUTO_TASK_PROMPT_MAX = 16_000;

export function resolveModelValue(input: {
  modelSelection: string;
  hasAutoRecord: boolean;
  accountTaskModelValue?: string;
  plainTaskModelValue: string;
  firstModelValue?: string;
}): string {
  return (
    input.modelSelection ||
    (input.hasAutoRecord
      ? AUTO_MODEL_VALUE
      : input.accountTaskModelValue ??
        (input.plainTaskModelValue || input.firstModelValue || ""))
  );
}

export function shouldAutoRetryEscalate(input: {
  previousStatus?: TaskStatus;
  currentStatus?: TaskStatus;
  limitError: boolean;
  hasEscalation: boolean;
  retried?: boolean;
  hasPrompt: boolean;
  autoRetrying: boolean;
  userMessageCount: number;
  hasCompletedAssistantText: boolean;
}): boolean {
  return (
    input.previousStatus !== undefined &&
    input.previousStatus !== "error" &&
    input.currentStatus === "error" &&
    !input.limitError &&
    input.hasEscalation &&
    !input.retried &&
    input.hasPrompt &&
    !input.autoRetrying &&
    input.userMessageCount <= 1 &&
    !input.hasCompletedAssistantText
  );
}

export function autoTaskStorageKey(taskId: string): string {
  return `webui:auto-task:${taskId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseDecision(value: unknown): AutoDecision | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.providerID !== "string" ||
    !value.providerID ||
    typeof value.modelID !== "string" ||
    !value.modelID ||
    !isAutoVariant(value.variant) ||
    (value.tier !== "light" && value.tier !== "standard" && value.tier !== "heavy") ||
    typeof value.reason !== "string"
  ) {
    return null;
  }
  const decision: AutoDecision = {
    providerID: value.providerID,
    modelID: value.modelID,
    ...(typeof value.accountId === "string" && value.accountId
      ? { accountId: value.accountId }
      : {}),
    variant: value.variant,
    tier: value.tier,
    mode: isAutoOptimizeMode(value.mode) ? value.mode : DEFAULT_AUTO_OPTIMIZE_MODE,
    reason: value.reason,
  };
  if (isRecord(value.escalation)) {
    const escalation = value.escalation;
    if (
      typeof escalation.providerID === "string" &&
      escalation.providerID &&
      typeof escalation.modelID === "string" &&
      escalation.modelID &&
      isAutoVariant(escalation.variant)
    ) {
      decision.escalation = {
        providerID: escalation.providerID,
        modelID: escalation.modelID,
        ...(typeof escalation.accountId === "string" && escalation.accountId
          ? { accountId: escalation.accountId }
          : {}),
        variant: escalation.variant,
      };
    }
  }
  return decision;
}

export function readAutoTaskRecord(taskId: string): AutoTaskRecord | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(autoTaskStorageKey(taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const decision = parseDecision(parsed.decision);
    if (!decision) return null;
    return {
      decision,
      ...(typeof parsed.prompt === "string" && parsed.prompt
        ? { prompt: parsed.prompt }
        : {}),
      ...(typeof parsed.agent === "string" && parsed.agent
        ? { agent: parsed.agent }
        : {}),
      ...(parsed.retried === true ? { retried: true } : {}),
      ...(parsed.dismissed === true ? { dismissed: true } : {}),
    };
  } catch {
    return null;
  }
}

export function writeAutoTaskRecord(
  taskId: string,
  record: AutoTaskRecord,
): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    sessionStorage.setItem(autoTaskStorageKey(taskId), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Drop the Auto sentinel so a concrete model choice survives remount. */
export function clearAutoTaskRecord(taskId: string): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    sessionStorage.removeItem(autoTaskStorageKey(taskId));
    return true;
  } catch {
    return false;
  }
}
