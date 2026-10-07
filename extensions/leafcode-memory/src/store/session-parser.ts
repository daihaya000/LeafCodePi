import fs from 'node:fs';
import path from 'node:path';

/**
 * Parsed session data from a JSONL file.
 */
export interface ParsedSession {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  messages: ParsedMessage[];
}

/**
 * A single parsed message from a session.
 */
export interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  toolCalls?: string[];
}

/**
 * Raw JSONL entry types.
 */
interface JsonlEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
  customType?: string;
  [key: string]: unknown;
}

/**
 * Extract text content from a message's content array.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      case 'thinking':
        // Skip thinking blocks — they're internal reasoning
        break;
      case 'tool_use':
        // Skip tool_use blocks — we track tool calls separately
        break;
      case 'tool_result':
        // Tool results commonly contain full file or command output. They are
        // ephemeral and can be very large; tool names are indexed separately.
        break;
    }
  }
  return parts.join('\n').trim();
}

/**
 * Extract tool call names from a message's content array.
 */
function extractToolCalls(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const toolNames: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if ((b.type === 'tool_use' || b.type === 'toolCall') && typeof b.name === 'string') {
      toolNames.push(b.name);
    }
  }
  return toolNames.length > 0 ? toolNames : undefined;
}

export interface ParseSessionFileOptions {
  /** Files larger than this are not parsed (returns null): live indexing must not load huge sessions. */
  maxBytes?: number;
}

/** Sessions above this size are never re-parsed on every message by live indexing or shutdown. */
export const MAX_LIVE_SESSION_FILE_BYTES = 32 * 1024 * 1024;
/** Bulk/startup indexing skips sessions above this size (the 517MB one exceeded V8's string limit). */
export const MAX_BULK_SESSION_FILE_BYTES = 256 * 1024 * 1024;
/** A single JSONL line above this size (for example an embedded image) is skipped, not buffered. */
export const MAX_JSONL_LINE_BYTES = 32 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Calls `onLine` for every non-blank line without ever materialising the whole file as one string.
 * `readFileSync(..., 'utf-8')` throws above V8's string limit (~512MB) and doubles memory below it.
 */
export function forEachJsonlLine(filePath: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let discarding = false;
    const flush = () => {
      if (!discarding && pendingBytes > 0) {
        const line = Buffer.concat(pending, pendingBytes).toString('utf-8');
        if (line.trim()) onLine(line);
      }
      pending = [];
      pendingBytes = 0;
      discarding = false;
    };
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, READ_CHUNK_BYTES, null);
      if (read === 0) break;
      let start = 0;
      while (start < read) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline === -1 || newline >= read ? read : newline;
        if (!discarding) {
          pendingBytes += end - start;
          if (pendingBytes > MAX_JSONL_LINE_BYTES) {
            discarding = true;
            pending = [];
            pendingBytes = 0;
          } else {
            pending.push(Buffer.from(chunk.subarray(start, end)));
          }
        }
        if (end === read) break;
        flush();
        start = end + 1;
      }
    }
    flush();
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse a Pi session JSONL file.
 *
 * @param filePath — Path to the .jsonl file
 * @returns Parsed session data, or null if the file is invalid
 */
export function parseSessionFile(filePath: string, options: ParseSessionFileOptions = {}): ParsedSession | null {
  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && fs.statSync(filePath).size > maxBytes) return null;

  // Assigned inside the line callback: widen so control-flow analysis does not narrow them to null.
  let sessionId = null as string | null;
  let sessionCwd = null as string | null;
  let sessionTimestamp = null as string | null;
  const messages: ParsedMessage[] = [];

  let sawLine = false;
  forEachJsonlLine(filePath, (line) => {
    sawLine = true;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      return; // Skip malformed lines
    }

    switch (entry.type) {
      case 'session':
        sessionId = entry.id ?? null;
        sessionCwd = entry.cwd ?? null;
        sessionTimestamp = entry.timestamp ?? null;
        break;

      case 'message': {
        if (!entry.message || !entry.id || !entry.timestamp) break;

        const role = entry.message.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') break;

        const textContent = extractTextContent(entry.message.content);
        if (!textContent) break; // Skip empty messages

        const toolCalls = role === 'assistant' ? extractToolCalls(entry.message.content) : undefined;

        messages.push({
          id: entry.id,
          role,
          content: textContent,
          timestamp: entry.timestamp,
          toolCalls,
        });
        break;
      }
      // Skip other entry types (model_change, thinking_level_change, custom, etc.)
    }
  });

  if (!sawLine) return null;
  if (!sessionId || !sessionCwd || !sessionTimestamp) return null;

  // Decode project name from cwd-encoded directory name
  // The directory is named like "--Users-chandrateja-Documents-leafcode-memory--"
  // We extract the last segment as the project name
  const project = sessionCwd.split('/').pop() ?? sessionCwd;

  return {
    id: sessionId,
    project,
    cwd: sessionCwd,
    startedAt: sessionTimestamp,
    endedAt: null, // We don't know when it ended from the JSONL
    messages,
  };
}

/**
 * Get all session JSONL files for a project (or all projects).
 *
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory name (e.g., "--Users-...--")
 * @returns Array of file paths
 */
export function getSessionFiles(sessionsDir: string, projectDir?: string): string[] {
  if (projectDir) {
    const dir = path.join(sessionsDir, projectDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  }

  // All projects
  if (!fs.existsSync(sessionsDir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(sessionsDir)) {
    const entryPath = path.join(sessionsDir, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      // Scan .jsonl files inside project subdirectories
      for (const f of fs.readdirSync(entryPath)) {
        if (f.endsWith('.jsonl')) {
          files.push(path.join(entryPath, f));
        }
      }
    } else if (stat.isFile() && entry.endsWith('.jsonl')) {
      // Also pick up root-level .jsonl files
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Decode a project directory name to a human-readable project name.
 * "--Users-chandrateja-Documents-leafcode-memory--" → "leafcode-memory"
 */
export function decodeProjectDir(dirName: string): string {
  // Remove leading/trailing dashes
  const cleaned = dirName.replace(/^-+|-+$/g, '');
  // Split by dash and take the last segment (project name)
  const segments = cleaned.split('-');
  return segments[segments.length - 1] ?? cleaned;
}
