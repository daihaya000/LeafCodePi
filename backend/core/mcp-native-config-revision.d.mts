/** PRIVATE fixed global mcp.json + bundled revision check. Inert construction; synchronous
 * bounded read-only assertions. Terminal on observed failures/reentrancy; new gate/lease
 * required after writes. No SDK validation, ACL policy, publication, writer barrier or CAS. */
export function createBackendMcpConfigRevisionCheck(options: {
  agentDir: string;
  bundledConfigPath: string;
  expectedSha256: string | null;
  expectedBundledSha256: string;
  assertRuntimeOwner: () => void;
}): () => void;
