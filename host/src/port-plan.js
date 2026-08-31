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

function isSsListenerOnPort(line, port) {
  const parts = line.trim().split(/\s+/);
  return parts.length >= 4 && /^LISTEN$/i.test(parts[0]) && (parts[3] ?? "").endsWith(`:${port}`);
}

/** Parse `ss -ltnp` output for PIDs listening on a TCP port. */
export function parseSsListeningPids(output, port) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    if (!isSsListenerOnPort(line, port)) continue;
    for (const match of String(line).matchAll(/\bpid=(\d+)\b/g)) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  return [...pids];
}

/** True when `ss` found a listener but did not expose its PID. */
export function hasSsListeningPort(output, port) {
  return String(output).split(/\r?\n/).some((line) => isSsListenerOnPort(line, port));
}

/** Parse `lsof ... -t` output, which prints one listening PID per line. */
export function parseLsofListeningPids(output, _port) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}
