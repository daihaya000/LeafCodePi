// Existing owner imports keep host capability evaluation; Browser uses the neutral catalog.
export * from "./ui/tts-backends";

export function isSapiAvailable(platform: NodeJS.Platform | string = process.platform): boolean {
  return platform === "win32";
}
