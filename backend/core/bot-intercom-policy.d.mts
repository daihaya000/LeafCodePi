export const BOT_INTERCOM_TRIGGER_POLICIES: readonly string[];

/** Idle-delivery wake decision for a trigger policy and message kind. */
export function shouldWakeIdleDelivery(policy: string | null | undefined, messageKind: string | null | undefined): boolean;

/** "offline" | "busy" | "online" from the caller's live-session facts. */
export function botIntercomPresence(input: {
  resident: boolean;
  waiting: boolean;
  busy: boolean;
  roomBusy: boolean;
}): "offline" | "busy" | "online";
