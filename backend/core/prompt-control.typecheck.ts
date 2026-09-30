import { buildPromptOptions, nextPromptEpoch, resolveStreamingBehaviorForPrompt } from "./prompt-control.mjs";

/** Compile-only checks for the public control contract. */
export function checkPromptControlTypes(): void {
  const options = buildPromptOptions({
    images: [{ mimeType: "image/png", data: "abc" }],
    streamingBehavior: "steer",
    isStreaming: true,
    isHangRetry: false,
  });
  const behavior: "steer" | "followUp" | undefined = options.streamingBehavior;
  const resolved: "steer" | "followUp" | undefined = resolveStreamingBehaviorForPrompt("steer", true);
  const epoch: number = nextPromptEpoch(undefined);
  void behavior;
  void resolved;
  void epoch;
  // @ts-expect-error Only steer and followUp are supported interrupt modes.
  buildPromptOptions({ streamingBehavior: "queue", isStreaming: false, isHangRetry: false });
  // @ts-expect-error Prompt epochs are numeric.
  nextPromptEpoch("1");
}
