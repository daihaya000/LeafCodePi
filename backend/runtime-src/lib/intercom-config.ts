import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePiAgentDir } from "@/lib/agents-md";
import { atomicWrite } from "@/lib/extensions";
import {
  DEFAULT_INTERCOM_TRIGGER_POLICY,
  isIntercomTriggerPolicy,
  type IntercomTriggerPolicy,
} from "@/lib/intercom-trigger";

type StoredIntercomConfig = Record<string, unknown>;

export function intercomConfigPath(agentDir = resolvePiAgentDir()): string {
  return join(agentDir, "intercom", "config.json");
}

function readStoredIntercomConfig(): StoredIntercomConfig {
  const file = intercomConfigPath();
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Intercom config must be a JSON object");
  }
  return parsed as StoredIntercomConfig;
}

export function readIntercomTriggerPolicy(): IntercomTriggerPolicy {
  const value = readStoredIntercomConfig().inboundTrigger;
  if (value === undefined) return DEFAULT_INTERCOM_TRIGGER_POLICY;
  if (!isIntercomTriggerPolicy(value)) {
    throw new Error('"inboundTrigger" must be "always", "replies", or "never"');
  }
  return value;
}

export function writeIntercomTriggerPolicy(policy: IntercomTriggerPolicy): IntercomTriggerPolicy {
  if (!isIntercomTriggerPolicy(policy)) {
    throw new Error('"inboundTrigger" must be "always", "replies", or "never"');
  }
  const config = readStoredIntercomConfig();
  config.inboundTrigger = policy;
  atomicWrite(intercomConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
  return policy;
}
