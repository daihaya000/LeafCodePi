export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // Resume delivery of Code results whose Bot report was interrupted by a restart.
    const { startBotCodeRelay } = await import("@/lib/pi/harness");
    startBotCodeRelay();
  } catch (error) {
    console.warn("[bot-code-relay] startup scan unavailable", error);
  }
}
