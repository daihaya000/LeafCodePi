export const DEFAULT_INTERCOM_TRIGGER_POLICY = "replies" as const;
export const INTERCOM_TRIGGER_POLICIES = ["replies", "always", "never"] as const;
export type IntercomTriggerPolicy = (typeof INTERCOM_TRIGGER_POLICIES)[number];

export type IntercomConfigDto = {
  inboundTrigger: IntercomTriggerPolicy;
};

export function isIntercomTriggerPolicy(value: unknown): value is IntercomTriggerPolicy {
  return INTERCOM_TRIGGER_POLICIES.includes(value as IntercomTriggerPolicy);
}
