/** Next starts HTTP transport only. Backend owns runtime startup and recovery. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Process ownership, not NODE_ENV: configuration never falls back to a Next writer.
  process.env.LEAFCODE_PI_PROCESS_ROLE = "next";
  try {
    const { installContentTypeStringHeader } = await import("@/lib/http-compression-fix");
    installContentTypeStringHeader();
  } catch (error) {
    console.warn("[http] content-type header fix unavailable", error);
  }
}
