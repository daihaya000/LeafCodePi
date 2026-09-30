/** Transitional Web entrypoint; execution startup is owned by the runtime layer. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { startRuntimeServices } = await import("@/lib/pi/runtime-startup");
    await startRuntimeServices();
  } catch (error) {
    console.warn("[bot-code-relay] startup scan unavailable", error);
  }
}
