import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUseExtension from "./upstream/computer-use.ts";

export default function leafcodeComputerUse(pi: ExtensionAPI): void {
  if (process.platform !== "win32" && process.platform !== "linux") return;
  computerUseExtension(pi);
}
