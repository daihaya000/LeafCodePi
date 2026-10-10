// Owner facade preserves OS-specific defaults; UI contract uses explicit platform input.
import * as contract from "./ui/llama-server-settings.mjs";
export * from "./ui/llama-server-settings.mjs";
function runtimePlatform() {
    return typeof process !== "undefined" && typeof process.platform === "string" ? process.platform : "win32";
}
export function isSafeLlamaPathValue(value, platform = runtimePlatform()) { return contract.isSafeLlamaPathValue(value, platform); }
export function isSafeLlamaModelFile(value, platform = runtimePlatform()) { return contract.isSafeLlamaModelFile(value, platform); }
export function resolveLlamaServerBin(value, platform = runtimePlatform()) { return contract.resolveLlamaServerBin(value, platform); }
export function isLlamaServerSettings(value, platform = runtimePlatform()) { return contract.isLlamaServerSettings(value, platform); }
export function parseLlamaServerSettings(value, platform = runtimePlatform()) { return contract.parseLlamaServerSettings(value, platform); }
