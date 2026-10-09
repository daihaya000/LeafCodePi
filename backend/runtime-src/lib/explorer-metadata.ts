import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { resolveHostControlUrl, isLoopbackControlUrl } from "./host-control";
/** Metadata only. Opening Explorer remains browser -> loopback Host, never remote Backend execution. */
export function explorerControlUrl(): string {
  assertConfigurationOwner();
  const value = resolveHostControlUrl(), url = new URL(value);
  if (!isLoopbackControlUrl(value) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid control endpoint");
  return value;
}
