/**
 * Intercom delivery and presence policy. Pure: the settings lookup, the live-session
 * lookups and the mailbox/thread state stay with the caller.
 */
export const BOT_INTERCOM_TRIGGER_POLICIES = ["never", "replies", "always"];

/**
 * Whether an idle, online Bot should be woken for a delivered message. `ask` always
 * needs a reply, so the "replies" policy wakes for it and nothing else; an
 * unreadable or unknown policy behaves like "replies".
 */
export function shouldWakeIdleDelivery(policy, messageKind) {
  if (policy === "never") return false;
  if (policy === "always") return true;
  return messageKind === "ask";
}

/**
 * Presence for a Bot: offline without a live session; busy while a reply is awaited,
 * the 1:1 session is prompting/streaming, or a Room turn is active (delivery stays
 * queued rather than steering into the 1:1 chat); otherwise online.
 */
export function botIntercomPresence({ resident, waiting, busy, roomBusy }) {
  if (resident !== true) return "offline";
  if (waiting === true || busy === true || roomBusy === true) return "busy";
  return "online";
}
