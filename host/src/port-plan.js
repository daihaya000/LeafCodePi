/**
 * Parse `netstat -ano` output for PIDs listening on a TCP port.
 * @param {string} output
 * @param {number} port
 * @returns {number[]}
 */
export function parseListeningPids(output, port) {
  const pids = new Set();
  const portSuffix = `:${port}`;
  for (const line of String(output).split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1] ?? "";
    const pid = Number(parts[parts.length - 1]);
    if (
      Number.isFinite(pid) &&
      pid > 0 &&
      (local.endsWith(portSuffix) || local.endsWith(`]${portSuffix}`))
    ) {
      pids.add(pid);
    }
  }
  return [...pids];
}
