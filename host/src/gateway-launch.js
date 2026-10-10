import { startSpaWithFallback } from "./spa-build.js";

/** The production Web child owns ingress only; never starts or probes the runtime owner. */
export function gatewayLaunchPlan(generation, env = {}) {
  if (!generation?.entry || !generation?.cwd || !generation?.staticRoot) throw new Error("Verified gateway generation required");
  if (env.LEAFCODE_PI_MODE === "dev") throw new Error("Secure gateway development entry is not configured");
  return { args: [generation.entry], cwd: generation.cwd, env: { ...env, NODE_ENV: "production", LEAFCODE_PI_PROCESS_ROLE: "next", LEAFCODE_PI_SPA_DIR: generation.staticRoot } };
}

/** Listen acknowledgement is Web liveness, not Backend/SDK readiness. Early failures cannot enter the crash budget. */
export async function launchProductionGateway({ mirrorRoot, checkout, env, spawn, stop, pipe = () => {}, log = () => {}, timeoutMs = 10000 } = {}) {
  return startSpaWithFallback({ mirrorRoot, checkout, log, start: async generation => {
    const plan = gatewayLaunchPlan(generation, env), child = spawn(plan.args, { cwd: plan.cwd, env: plan.env });
    try {
      await new Promise((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(() => finish(Error("Gateway listen deadline")), timeoutMs);
        const onError = error => finish(error), onClose = () => finish(Error("Gateway exited before listening"));
        const onData = chunk => {
          buffer += chunk.toString();
          if (buffer.length > 65536) return finish(Error("Gateway startup output exceeded limit"));
          for (let index; (index = buffer.indexOf("\n")) >= 0;) {
            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
            try { const message = JSON.parse(line); if (message.type === "gateway_listening" && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) return finish(); } catch { /* non-ack diagnostic */ }
          }
        };
        function finish(error) { clearTimeout(timer); child.stdout?.off("data", onData); child.off("error", onError); child.off("close", onClose); error ? reject(error) : resolve(); }
        child.stdout?.on("data", onData); child.once("error", onError); child.once("close", onClose);
        try { pipe(child); } catch (error) { finish(error); }
      });
      if (child.exitCode !== null || child.signalCode !== null) throw Error("Gateway exited during admission");
      return child;
    } catch (error) { await stop(child); throw error; }
  } });
}
