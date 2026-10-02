import type { UiMessage } from "@/lib/types";

/** Only transport/response failures can be reconciled; explicit owner rejections stay errors. */
export function isUnconfirmedPromptDelivery(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "BACKEND_FORWARD_FAILED" &&
    !("reason" in error && ["unauthorized", "incompatible", "not-configured"].includes(
      String((error as { reason?: unknown }).reason),
    ));
}

/** A remapped old message or a working status is not proof that this input was received. */
export function hasReceivedSubmittedPrompt(
  before: readonly UiMessage[],
  after: readonly UiMessage[],
  text: string,
): boolean {
  if (!text.trim()) return false;
  const ids = new Set(before.map((message) => message.id));
  const lastUserTime = before.reduce((latest, message) => (
    message.role === "user" && Number.isFinite(message.createdAt)
      ? Math.max(latest, message.createdAt)
      : latest
  ), -Infinity);
  return after.some((message) => (
    message.role === "user"
    && !ids.has(message.id)
    && Number.isFinite(message.createdAt)
    && message.createdAt > lastUserTime
    && message.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n") === text
  ));
}
