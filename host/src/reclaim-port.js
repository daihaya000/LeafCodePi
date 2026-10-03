// Called by start.sh before the host starts. Never fails the launch: the host
// still reports a clear EADDRINUSE if something else owns the port.
import { reclaimStalePort } from "./stale-port.js";

try {
  const { port, skipped, stopped, foreign } = await reclaimStalePort();
  if (skipped) {
    // A running host owns the port on purpose.
  } else {
    for (const pid of stopped) console.log(`[start] Stopped stale LeafCodePi WebUI on port ${port} (PID ${pid})`);
    for (const { pid, commandLine } of foreign) {
      console.error(`[start] Port ${port} is held by another program (PID ${pid}: ${commandLine || "unknown"}). Stop it or set LEAFCODE_PI_PORT.`);
    }
  }
} catch (err) {
  console.error(`[start] Port check skipped: ${err instanceof Error ? err.message : String(err)}`);
}
