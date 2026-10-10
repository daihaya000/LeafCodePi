import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchProductionGateway } from "../host/src/gateway-launch.js";
import { resolveSpaMirrorRoot } from "./spa-build-generation.mjs";
const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

export function productionStartOptions(args = [], env = process.env) {
  const result = { mirrorRoot: resolveSpaMirrorRoot(env, join(ROOT, "web")), env: { ...env, LEAFCODE_PI_MODE: "production" } };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], value = args[++index];
    if (!value || value.startsWith("--")) throw Error(`Missing production start option value: ${arg}`);
    if (arg === "--mirror") result.mirrorRoot = resolve(value);
    else if (arg === "--hostname") result.env.LEAFCODE_PI_BIND_HOST = value;
    else if (arg === "--port") {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw Error("Invalid production port");
      result.env.LEAFCODE_PI_PORT = value;
    } else throw Error(`Unsupported production start option: ${arg}`);
  }
  return result;
}
export async function stopProductionChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once("exit", done)); child.kill();
  let timer; await Promise.race([exited, new Promise(done => { timer = setTimeout(done, 3000); })]); clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}
export async function startProductionGateway({ args = [], env = process.env, launch = launchProductionGateway, spawnChild = spawn, pipe = () => {}, log = () => {} } = {}) {
  const options = productionStartOptions(args, env);
  return launch({ ...options, checkout: ROOT, spawn: (argv, config) => spawnChild(process.execPath, argv, { ...config, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }), stop: stopProductionChild, pipe, log });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let child, stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void stopProductionChild(child); } };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const run = await startProductionGateway({ args: process.argv.slice(2), pipe: run => {
      child = run; run.stdout.pipe(process.stdout); run.stderr.pipe(process.stderr);
      run.once("exit", (code, signal) => { process.exitCode = stopping ? 0 : code ?? (signal ? 1 : 0); });
      if (stopping) void stopProductionChild(run);
    }, log: text => process.stderr.write(text + "\n") });
    child = run.process;
  } catch (error) { console.error(error.message); process.exitCode = 1; await stopProductionChild(child); }
}
