import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUseExtension from "./upstream/computer-use.ts";

export default function leafcodeComputerUse(pi: ExtensionAPI): void {
  if (process.platform !== "win32") return;
  computerUseExtension(pi);
}
