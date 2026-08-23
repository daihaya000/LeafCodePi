import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { collaborationDataDir, readCollaborationConfig, type CollaborationConfig } from "./config.ts";

const SNAPSHOT_SCHEMA = 1;
const MAX_RPC_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 5_000;
const MAX_SELECTOR_COUNT = 64;
const MAX_PATH_LENGTH = 1_000;

export type PresenceState = "active" | "idle" | "away" | "stuck" | "offline";
export type LeaseState = "active" | "dirty" | "invalid" | "orphaned" | "released";
export type PresenceUpdate = {
  state?: Exclude<PresenceState, "offline">;
  currentTool?: string | null;
  currentPaths?: string[];
  progress?: boolean;
};

export type FileIdentity = {
  realpath: string;
  dev: number;
  ino: number;
  nlink: number;
};

export type ActivityEntry = {
  seq: number;
  kind: "join" | "leave" | "heartbeat" | "claim" | "reserve" | "release" | "write" | "edit" | "lease-invalid";
  sessionId: string;
  paths: string[];
  at: string;
};

export type SessionPresence = {
  sessionId: string;
  connectionId: string;
  displayName: string;
  pid: number;
  state: PresenceState;
  taskId?: string;
  goal?: string;
  currentTool?: string;
  currentPaths: string[];
  joinedAt: string;
  lastHeartbeatAt: string;
  lastProgressAt: string;
};

export type TaskClaim = {
  id: string;
  ownerSessionId: string;
  title: string;
  goal?: string;
  leaseIds: string[];
  status: "active" | "blocked" | "done";
  updatedAt: string;
};

export type FileLease = {
  id: string;
  ownerSessionId: string;
  selectors: string[];
  epoch: number;
  fencingToken: number;
  state: LeaseState;
  acquiredHeadOid?: string;
  baseline: Record<string, string | null>;
  observed: Record<string, string | null>;
  identities: Record<string, FileIdentity>;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
};

export type RoomSnapshot = {
  schema: 1;
  projectKey: string;
  epoch: number;
  seq: number;
  head: { branch?: string; oid?: string };
  sessions: Record<string, SessionPresence>;
  tasks: Record<string, TaskClaim>;
  leases: Record<string, FileLease>;
  activity: ActivityEntry[];
  updatedAt: string;
};

export type ProjectIdentity = {
  root: string;
  projectKey: string;
  roomDir: string;
  lockPath: string;
  snapshotPath: string;
  socketPath: string;
};

export type RoomSessionInfo = {
  sessionId: string;
  displayName?: string;
  pid?: number;
};

type LockRecord = {
  schema: 1;
  pid: number;
  connectionId: string;
  epoch: number;
  heartbeatAt: string;
};

type RpcRequest = {
  id: string;
  method: string;
  payload?: unknown;
  epoch: number;
  sessionId: string;
  connectionId: string;
};

type RpcResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

type CommandResult = { code: number; stdout: string; stderr: string };

export class RoomError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class LockHeldError extends RoomError {
  constructor() {
    super("lock_held", "Another LeafCode coordinator owns this room.");
  }
}

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function relativeKey(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeName(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, " ").trim();
  return normalized.slice(0, 120) || fallback;
}

function command(cwd: string, args: string[], timeoutMs = 8_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* process already exited */
      }
      reject(new RoomError("command_timeout", `git timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function resolveProjectIdentity(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectIdentity> {
  const result = await command(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) throw new RoomError("not_git_repository", result.stderr.trim() || "cwd is not a Git repository.");
  const root = fs.realpathSync.native(result.stdout.trim());
  const projectKey = createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex");
  const roomDir = path.join(collaborationDataDir(env), "rooms", projectKey);
  return {
    root,
    projectKey,
    roomDir,
    lockPath: path.join(roomDir, "coordinator.lock"),
    snapshotPath: path.join(roomDir, "snapshot.json"),
    socketPath: process.platform === "win32" ? `\\\\.\\pipe\\leafcode-pi-${projectKey}` : path.join(roomDir, "room.sock"),
  };
}

export function normalizeSelector(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || value.includes("\0")) {
    throw new RoomError("invalid_path", "Path selector is invalid.");
  }
  const raw = value.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\")) {
    throw new RoomError("invalid_path", "Absolute paths are not allowed.");
  }
  const prefix = raw.endsWith("/**");
  const body = prefix ? raw.slice(0, -3) : raw;
  if (!body || body.includes("*") || body.includes("?") || body.split("/").some((part) => part === "..")) {
    throw new RoomError("invalid_path", "Only exact paths and a trailing /** selector are allowed.");
  }
  const parts = body.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) throw new RoomError("invalid_path", "Path traversal is not allowed.");
  if (parts.includes(".git") || parts.includes(".env") || parts.includes(".ssh") || parts.includes(".aws") || parts.includes("node_modules")) {
    throw new RoomError("protected_path", "Protected paths cannot be reserved.");
  }
  const normalized = relativeKey(parts.join("/"));
  return prefix ? `${normalized}/**` : normalized;
}

export function selectorBase(selector: string): string {
  return selector.endsWith("/**") ? selector.slice(0, -3) : selector;
}

export function selectorMatches(selector: string, target: string): boolean {
  const base = relativeKey(selectorBase(selector));
  const candidate = relativeKey(target);
  return selector.endsWith("/**") ? candidate === base || candidate.startsWith(`${base}/`) : candidate === base;
}

export function selectorsOverlap(left: string, right: string): boolean {
  return selectorMatches(left, selectorBase(right)) || selectorMatches(right, selectorBase(left));
}

function relativePath(root: string, absolute: string): string {
  return relativeKey(path.relative(root, absolute));
}

function assertPathChain(root: string, relative: string): string {
  const absolute = path.resolve(root, ...relative.split("/"));
  if (!isUnder(root, absolute)) throw new RoomError("invalid_path", "Path escapes the repository root.");
  let existing = root;
  for (const part of relative.split("/")) {
    const current = path.join(existing, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new RoomError("path_identity", "Symlink or junction paths are not allowed.");
    if (process.platform === "win32" && (stat.isDirectory() || stat.isFile())) {
      const real = fs.realpathSync.native(current);
      if (pathKey(real) !== pathKey(current)) throw new RoomError("path_identity", "Junction or redirected paths are not allowed.");
    }
    existing = current;
  }
  const realCurrent = fs.realpathSync.native(existing);
  if (!isUnder(fs.realpathSync.native(root), realCurrent)) throw new RoomError("path_identity", "Path realpath escapes the repository root.");
  return absolute;
}

function identityFor(absolute: string): FileIdentity | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || stat.isDirectory()) throw new RoomError("path_identity", "Mutation targets must be regular files without links.");
  if (stat.nlink > 1) throw new RoomError("path_identity", "Hard-linked files are not supported.");
  return {
    realpath: fs.realpathSync.native(absolute),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    nlink: Number(stat.nlink),
  };
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  if (pathKey(left.realpath) !== pathKey(right.realpath)) return false;
  if (left.dev && right.dev && left.dev !== right.dev) return false;
  if (left.ino && right.ino && left.ino !== right.ino) return false;
  return right.nlink <= 1;
}

function fingerprintAbsolute(absolute: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new RoomError("path_identity", "Only regular, non-linked files can be mutated.");
  if (stat.size > MAX_CONTENT_BYTES * 8) throw new RoomError("file_too_large", "Fingerprint target is too large.");
  return createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
}

function fingerprintAt(root: string, relative: string): { fingerprint: string | null; identity?: FileIdentity } {
  const absolute = assertPathChain(root, relative);
  const identity = identityFor(absolute);
  return { fingerprint: fingerprintAbsolute(absolute), ...(identity ? { identity } : {}) };
}

function scanSelector(root: string, selector: string): { fingerprints: Record<string, string | null>; identities: Record<string, FileIdentity> } {
  const base = selectorBase(selector);
  if (!selector.endsWith("/**")) {
    const target = fingerprintAt(root, base);
    return {
      fingerprints: { [base]: target.fingerprint },
      identities: target.identity ? { [base]: target.identity } : {},
    };
  }
  const baseAbsolute = assertPathChain(root, base);
  if (!fs.existsSync(baseAbsolute)) return { fingerprints: {}, identities: {} };
  if (!fs.statSync(baseAbsolute).isDirectory()) throw new RoomError("invalid_path", "Prefix selectors must target a directory.");
  const fingerprints: Record<string, string | null> = {};
  const identities: Record<string, FileIdentity> = {};
  const pending = [baseAbsolute];
  let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new RoomError("path_identity", "Prefix selectors cannot contain symlinks or junctions.");
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      const relative = relativePath(root, absolute);
      const target = fingerprintAt(root, relative);
      fingerprints[relative] = target.fingerprint;
      if (target.identity) identities[relative] = target.identity;
      count += 1;
      if (count > MAX_SCAN_FILES) throw new RoomError("scan_limit", "Prefix selector contains too many files.");
    }
  }
  return { fingerprints, identities };
}

function assertSelectorOutsideRoom(identity: ProjectIdentity, selector: string): void {
  const relativeRoom = relativePath(identity.root, identity.roomDir);
  if (!relativeRoom || relativeRoom === "." || relativeRoom.startsWith("..") || path.isAbsolute(relativeRoom)) return;
  const roomSelector = `${relativeRoom}/**`;
  if (selectorsOverlap(selector, roomSelector)) throw new RoomError("protected_path", "The room state directory cannot be reserved.");
}

async function isDirty(root: string, selector: string): Promise<boolean> {
  const result = await command(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", selectorBase(selector)]);
  if (result.code !== 0) throw new RoomError("git_status", result.stderr.trim() || "Unable to inspect Git status.");
  return Boolean(result.stdout.trim());
}

async function readHead(root: string): Promise<{ branch?: string; oid?: string }> {
  const [branch, oid] = await Promise.all([
    command(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    command(root, ["rev-parse", "HEAD"]),
  ]);
  return {
    ...(branch.code === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
    ...(oid.code === 0 && oid.stdout.trim() ? { oid: oid.stdout.trim() } : {}),
  };
}

function emptySnapshot(projectKey: string): RoomSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    projectKey,
    epoch: 0,
    seq: 0,
    head: {},
    sessions: {},
    tasks: {},
    leases: {},
    activity: [],
    updatedAt: now(),
  };
}

function loadSnapshot(identity: ProjectIdentity): RoomSnapshot {
  if (!fs.existsSync(identity.snapshotPath)) return emptySnapshot(identity.projectKey);
  try {
    const parsed = JSON.parse(fs.readFileSync(identity.snapshotPath, "utf8")) as RoomSnapshot;
    if (
      parsed.schema !== SNAPSHOT_SCHEMA ||
      parsed.projectKey !== identity.projectKey ||
      !parsed.head ||
      !parsed.sessions ||
      Array.isArray(parsed.sessions) ||
      !parsed.tasks ||
      Array.isArray(parsed.tasks) ||
      !parsed.leases ||
      Array.isArray(parsed.leases) ||
      !Array.isArray(parsed.activity)
    ) {
      throw new Error("invalid snapshot shape");
    }
    return parsed;
  } catch (error) {
    throw new RoomError("snapshot_corrupt", `Room snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function persistJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function activeLease(state: LeaseState): boolean {
  return state === "active" || state === "dirty" || state === "invalid" || state === "orphaned";
}

function validateRpcRequest(value: unknown): RpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoomError("invalid_request", "Request must be an object.");
  const request = value as Partial<RpcRequest>;
  if (typeof request.id !== "string" || request.id.length > 100 || typeof request.method !== "string" || request.method.length > 80) {
    throw new RoomError("invalid_request", "Request id and method are invalid.");
  }
  if (typeof request.epoch !== "number" || !Number.isSafeInteger(request.epoch) || typeof request.sessionId !== "string" || typeof request.connectionId !== "string") {
    throw new RoomError("invalid_request", "Request identity is invalid.");
  }
  return request as RpcRequest;
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RoomError("invalid_payload", "Payload must be an object.");
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new RoomError("invalid_payload", `${label} is invalid.`);
  return value;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(identity: ProjectIdentity): LockRecord | undefined {
  try {
    const lock = JSON.parse(fs.readFileSync(identity.lockPath, "utf8")) as LockRecord;
    if (lock.schema !== 1 || !Number.isInteger(lock.pid) || typeof lock.connectionId !== "string" || !Number.isInteger(lock.epoch) || typeof lock.heartbeatAt !== "string") return undefined;
    return lock;
  } catch {
    return undefined;
  }
}

function staleLock(identity: ProjectIdentity, config: CollaborationConfig): boolean {
  const lock = readLock(identity);
  if (!lock) return false;
  if (processIsAlive(lock.pid)) return false;
  const heartbeatAt = Date.parse(lock.heartbeatAt);
  return Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt >= config.stuckAfterMs;
}

function takeOverStaleLock(identity: ProjectIdentity, config: CollaborationConfig): boolean {
  if (!staleLock(identity, config)) return false;
  const moved = `${identity.lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(identity.lockPath, moved);
    fs.rmSync(moved, { force: true });
    return true;
  } catch {
    return false;
  }
}

class JsonRpcChannel {
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(private readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new RoomError("room_disconnected", "Coordinator connection closed.")));
  }

  static connect(socketPath: string, timeoutMs = 1_500): Promise<JsonRpcChannel> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RoomError("room_unavailable", "Coordinator connection timed out."));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new JsonRpcChannel(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(request: RpcRequest, timeoutMs = 5_000): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new RoomError("room_timeout", `Coordinator request '${request.method}' timed out.`));
      }, timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.socket.destroy();
    this.fail(new RoomError("room_disconnected", "Coordinator connection closed."));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_BYTES) {
      this.close();
      return;
    }
    while (true) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as RpcResponse;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve(response);
      } catch {
        this.close();
        return;
      }
    }
  }

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class Coordinator {
  private lockFd = -1;
  private readonly lockConnectionId = randomUUID();
  private server: net.Server | undefined;
  private lockTimer: NodeJS.Timeout | undefined;
  private fencingSequence = 1;
  private operationTail: Promise<void> = Promise.resolve();
  private state: RoomSnapshot;
  private readonly socketConnections = new Map<net.Socket, { sessionId: string; connectionId: string } | undefined>();

  constructor(private readonly identity: ProjectIdentity, private readonly config: CollaborationConfig) {
    this.state = emptySnapshot(identity.projectKey);
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.identity.roomDir, { recursive: true, mode: 0o700 });
    try {
      this.lockFd = fs.openSync(this.identity.lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LockHeldError();
      throw error;
    }
    try {
      this.writeLock();
      this.state = loadSnapshot(this.identity);
      this.state.epoch += 1;
      for (const session of Object.values(this.state.sessions)) session.state = "offline";
      for (const lease of Object.values(this.state.leases)) {
        if (activeLease(lease.state)) lease.state = "orphaned";
      }
      this.fencingSequence = Math.max(1, ...Object.values(this.state.leases).map((lease) => lease.fencingToken + 1));
      this.state.head = await readHead(this.identity.root);
      this.writeLock();
      if (process.platform !== "win32") fs.rmSync(this.identity.socketPath, { force: true });
      this.server = net.createServer((socket) => this.handleSocket(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.identity.socketPath, () => resolve());
      });
      this.lockTimer = setInterval(() => {
        try {
          this.expireCleanLeases();
          this.writeLock();
          this.persist();
        } catch {
          // A failed heartbeat makes takeover conservative; mutations still fail on RPC.
        }
      }, Math.max(500, Math.floor(this.config.heartbeatMs)));
      this.persist();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const ownedLock = this.lockFd >= 0;
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = undefined;
    for (const socket of this.socketConnections.keys()) socket.destroy();
    this.socketConnections.clear();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    if (ownedLock && process.platform !== "win32") fs.rmSync(this.identity.socketPath, { force: true });
    if (this.lockFd >= 0) {
      try { fs.closeSync(this.lockFd); } catch { /* already closed */ }
      this.lockFd = -1;
    }
    if (ownedLock) {
      const lock = readLock(this.identity);
      if (lock?.pid === process.pid && lock.connectionId === this.lockConnectionId) {
        fs.rmSync(this.identity.lockPath, { force: true });
      }
    }
  }

  async invoke(request: RpcRequest): Promise<RpcResponse> {
    const operation = this.operationTail.then(() => this.invokeSerial(request));
    this.operationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async invokeSerial(request: RpcRequest): Promise<RpcResponse> {
    try {
      const valid = validateRpcRequest(request);
      const result = await this.handle(valid);
      return { id: valid.id, ok: true, result: clone(result) };
    } catch (error) {
      const roomError = error instanceof RoomError ? error : new RoomError("internal", error instanceof Error ? error.message : String(error));
      return { id: request.id, ok: false, error: { code: roomError.code, message: roomError.message, details: roomError.details } };
    }
  }

  private handleSocket(socket: net.Socket): void {
    this.socketConnections.set(socket, undefined);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RPC_BYTES) {
        socket.destroy();
        return;
      }
      while (true) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => {
      const connection = this.socketConnections.get(socket);
      this.socketConnections.delete(socket);
      if (connection && this.state.sessions[connection.sessionId]?.connectionId === connection.connectionId) {
        void this.markDisconnected(connection.sessionId);
      }
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: RpcRequest;
    try {
      request = validateRpcRequest(JSON.parse(line));
    } catch (error) {
      socket.destroy();
      return;
    }
    const response = await this.invoke(request);
    if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
    if (request.method === "join" && response.ok) {
      this.socketConnections.set(socket, { sessionId: request.sessionId, connectionId: request.connectionId });
    }
  }

  private async handle(request: RpcRequest): Promise<unknown> {
    if (request.method === "join") return this.join(request);
    const session = this.state.sessions[request.sessionId];
    if (!session || session.connectionId !== request.connectionId || session.state === "offline") {
      throw new RoomError("session_not_joined", "Session is not connected to this room.");
    }
    if (request.epoch !== this.state.epoch) throw new RoomError("stale_epoch", "Room epoch changed; reconnect is required.", { epoch: this.state.epoch });
    switch (request.method) {
      case "heartbeat": return this.heartbeat(request.sessionId, payloadObject(request.payload ?? {}));
      case "leave": return this.leave(request.sessionId);
      case "status": return this.status();
      case "claim": return this.claim(request.sessionId, payloadObject(request.payload));
      case "reserve": return this.reserve(request.sessionId, payloadObject(request.payload));
      case "release": return this.release(request.sessionId, payloadObject(request.payload));
      case "mutate_write": return this.mutate(request.sessionId, payloadObject(request.payload), "write");
      case "mutate_edit": return this.mutate(request.sessionId, payloadObject(request.payload), "edit");
      default: throw new RoomError("unknown_method", `Unknown room method '${request.method}'.`);
    }
  }

  private join(request: RpcRequest): RoomSnapshot {
    const payload = payloadObject(request.payload);
    const sessionId = requireString(payload.sessionId ?? request.sessionId, "sessionId", 200);
    const connectionId = requireString(payload.connectionId ?? request.connectionId, "connectionId", 200);
    if (sessionId !== request.sessionId || connectionId !== request.connectionId) throw new RoomError("invalid_payload", "Join identity does not match the request.");
    const displayName = safeName(typeof payload.displayName === "string" ? payload.displayName : "LeafCode session", "LeafCode session");
    const timestamp = now();
    const previous = this.state.sessions[sessionId];
    if (previous && previous.connectionId !== connectionId) {
      for (const lease of Object.values(this.state.leases)) {
        if (lease.ownerSessionId === sessionId && activeLease(lease.state)) lease.state = "orphaned";
      }
    }
    this.state.sessions[sessionId] = {
      sessionId,
      connectionId,
      displayName,
      pid: typeof payload.pid === "number" && Number.isInteger(payload.pid) ? payload.pid : 0,
      state: "active",
      currentPaths: [],
      joinedAt: previous?.joinedAt ?? timestamp,
      lastHeartbeatAt: timestamp,
      lastProgressAt: timestamp,
    };
    this.touch("join", sessionId, []);
    return this.state;
  }

  private heartbeat(sessionId: string, payload: Record<string, unknown>): RoomSnapshot {
    const session = this.state.sessions[sessionId]!;
    const timestamp = now();
    session.lastHeartbeatAt = timestamp;
    if (session.state === "offline") session.state = "active";
    if (payload.state !== undefined) {
      if (payload.state !== "active" && payload.state !== "idle" && payload.state !== "away" && payload.state !== "stuck") {
        throw new RoomError("invalid_payload", "Presence state is invalid.");
      }
      session.state = payload.state;
    }
    if (payload.currentTool !== undefined) {
      if (payload.currentTool === null) session.currentTool = undefined;
      else session.currentTool = requireString(payload.currentTool, "currentTool", 120);
    }
    if (payload.currentPaths !== undefined) {
      if (!Array.isArray(payload.currentPaths) || payload.currentPaths.length > MAX_SELECTOR_COUNT) throw new RoomError("invalid_payload", "currentPaths is invalid.");
      session.currentPaths = payload.currentPaths.map((value) => normalizeSelector(value)).filter((value) => !value.endsWith("/**"));
    }
    if (payload.progress === true) session.lastProgressAt = timestamp;
    if (session.state !== "away" && Date.now() - Date.parse(session.lastProgressAt) >= this.config.stuckAfterMs) session.state = "stuck";
    this.validateActiveLeases();
    this.expireCleanLeases();
    this.touch("heartbeat", sessionId, []);
    return this.state;
  }

  private async markDisconnected(sessionId: string): Promise<void> {
    const session = this.state.sessions[sessionId];
    if (!session || session.state === "offline") return;
    session.state = "offline";
    for (const lease of Object.values(this.state.leases)) {
      if (lease.ownerSessionId === sessionId && activeLease(lease.state)) lease.state = "orphaned";
    }
    this.touch("leave", sessionId, []);
    if (!Object.values(this.state.sessions).some((entry) => entry.state !== "offline")) await this.close();
  }

  private leave(sessionId: string): RoomSnapshot {
    const session = this.state.sessions[sessionId]!;
    session.state = "offline";
    for (const lease of Object.values(this.state.leases)) {
      if (lease.ownerSessionId !== sessionId) continue;
      if (lease.state === "active") lease.state = "released";
      else if (activeLease(lease.state)) lease.state = "orphaned";
    }
    this.touch("leave", sessionId, []);
    if (!Object.values(this.state.sessions).some((entry) => entry.state !== "offline")) setTimeout(() => { void this.close(); }, 0).unref?.();
    return this.state;
  }

  private status(): RoomSnapshot {
    this.validateActiveLeases();
    this.expireCleanLeases();
    return this.state;
  }

  private claim(sessionId: string, payload: Record<string, unknown>): TaskClaim {
    const title = requireString(payload.title, "title");
    const taskId = typeof payload.taskId === "string" && payload.taskId.trim() ? payload.taskId.trim().slice(0, 200) : randomUUID();
    const existing = this.state.tasks[taskId];
    if (existing && existing.ownerSessionId !== sessionId && existing.status !== "done") throw new RoomError("task_conflict", "Task is already claimed by another session.");
    const task: TaskClaim = {
      id: taskId,
      ownerSessionId: sessionId,
      title,
      ...(typeof payload.goal === "string" && payload.goal.trim() ? { goal: payload.goal.trim().slice(0, 2_000) } : {}),
      leaseIds: existing?.leaseIds ?? [],
      status: "active",
      updatedAt: now(),
    };
    this.state.tasks[taskId] = task;
    this.state.sessions[sessionId]!.taskId = taskId;
    this.state.sessions[sessionId]!.goal = task.goal;
    this.touch("claim", sessionId, []);
    return task;
  }

  private async reserve(sessionId: string, payload: Record<string, unknown>): Promise<FileLease> {
    if (!Array.isArray(payload.paths) || payload.paths.length < 1 || payload.paths.length > MAX_SELECTOR_COUNT) throw new RoomError("invalid_payload", "reserve requires 1-64 paths.");
    const selectors = [...new Set(payload.paths.map((value) => normalizeSelector(value)))];
    for (const selector of selectors) assertSelectorOutsideRoom(this.identity, selector);
    for (const lease of Object.values(this.state.leases)) {
      if (!activeLease(lease.state) || lease.ownerSessionId === sessionId) continue;
      if (selectors.some((selector) => lease.selectors.some((other) => selectorsOverlap(selector, other)))) {
        throw new RoomError("lease_conflict", "Requested paths overlap another active or orphaned lease.", { leaseId: lease.id, ownerSessionId: lease.ownerSessionId });
      }
    }
    const baseline: Record<string, string | null> = {};
    const identities: Record<string, FileIdentity> = {};
    for (const selector of selectors) {
      if (await isDirty(this.identity.root, selector)) throw new RoomError("foreign_change", `Path '${selector}' already has an unowned Git change.`);
      const scanned = scanSelector(this.identity.root, selector);
      Object.assign(baseline, scanned.fingerprints);
      Object.assign(identities, scanned.identities);
    }
    const timestamp = now();
    const lease: FileLease = {
      id: randomUUID(),
      ownerSessionId: sessionId,
      selectors,
      epoch: this.state.epoch,
      fencingToken: this.fencingSequence++,
      state: "active",
      ...(this.state.head.oid ? { acquiredHeadOid: this.state.head.oid } : {}),
      baseline,
      observed: { ...baseline },
      identities,
      acquiredAt: timestamp,
      renewedAt: timestamp,
      expiresAt: new Date(Date.now() + this.config.leaseTtlMs).toISOString(),
    };
    this.state.leases[lease.id] = lease;
    this.touch("reserve", sessionId, selectors);
    return lease;
  }

  private release(sessionId: string, payload: Record<string, unknown>): FileLease {
    const leaseId = requireString(payload.leaseId, "leaseId", 100);
    const lease = this.state.leases[leaseId];
    if (!lease || lease.ownerSessionId !== sessionId) throw new RoomError("lease_not_owned", "Lease is not owned by this session.");
    if (lease.state !== "active") throw new RoomError("lease_not_clean", `Lease cannot be released from state '${lease.state}'.`);
    lease.state = "released";
    lease.renewedAt = now();
    this.touch("release", sessionId, lease.selectors);
    return lease;
  }

  private async mutate(sessionId: string, payload: Record<string, unknown>, operation: "write" | "edit"): Promise<{ path: string; fingerprint: string; leaseId: string; epoch: number; fencingToken: number }> {
    const target = normalizeSelector(payload.path);
    if (target.endsWith("/**")) throw new RoomError("invalid_path", "Mutation path must be an exact file path.");
    const lease = Object.values(this.state.leases).find((entry) => entry.ownerSessionId === sessionId && activeLease(entry.state) && entry.epoch === this.state.epoch && entry.selectors.some((selector) => selectorMatches(selector, target)));
    if (!lease) throw new RoomError("lease_required", "An active lease covering this path is required.");
    if (lease.state !== "active" && lease.state !== "dirty") throw new RoomError("lease_invalid", `Lease is '${lease.state}'.`);
    this.validateLease(lease);
    const current = fingerprintAt(this.identity.root, target);
    const expected = lease.observed[target] ?? null;
    if (current.fingerprint !== expected || !sameIdentity(lease.identities[target], current.identity)) {
      lease.state = "invalid";
      this.touch("lease-invalid", sessionId, [target]);
      throw new RoomError("foreign_change", "Target changed after lease acquisition.");
    }
    let content: string;
    if (operation === "write") {
      if (typeof payload.content !== "string") throw new RoomError("invalid_payload", "content is required.");
      content = payload.content;
    } else {
      const oldText = requireString(payload.oldText, "oldText", MAX_CONTENT_BYTES);
      if (typeof payload.newText !== "string") throw new RoomError("invalid_payload", "newText is required.");
      const absolute = path.resolve(this.identity.root, ...target.split("/"));
      if (!fs.existsSync(absolute)) throw new RoomError("missing_file", "Edit target does not exist.");
      const currentText = fs.readFileSync(absolute, "utf8");
      const first = currentText.indexOf(oldText);
      if (first < 0 || currentText.indexOf(oldText, first + oldText.length) >= 0) throw new RoomError("edit_mismatch", "oldText must match exactly once.");
      content = `${currentText.slice(0, first)}${payload.newText}${currentText.slice(first + oldText.length)}`;
    }
    if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new RoomError("content_too_large", "Mutation content is too large.");
    const recheck = fingerprintAt(this.identity.root, target);
    if (recheck.fingerprint !== expected || !sameIdentity(lease.identities[target], recheck.identity)) {
      lease.state = "invalid";
      this.touch("lease-invalid", sessionId, [target]);
      throw new RoomError("foreign_change", "Target changed during mutation preparation.");
    }
    atomicWrite(this.identity.root, target, content, expected, lease.identities[target]);
    const after = fingerprintAt(this.identity.root, target);
    if (!after.fingerprint || !after.identity) {
      lease.state = "invalid";
      throw new RoomError("mutation_failed", "Mutation did not produce a regular file.");
    }
    lease.observed[target] = after.fingerprint;
    lease.identities[target] = after.identity;
    lease.state = "dirty";
    lease.renewedAt = now();
    lease.expiresAt = new Date(Date.now() + this.config.leaseTtlMs).toISOString();
    this.state.sessions[sessionId]!.currentPaths = [target];
    this.touch(operation, sessionId, [target]);
    return { path: target, fingerprint: after.fingerprint, leaseId: lease.id, epoch: lease.epoch, fencingToken: lease.fencingToken };
  }

  private validateLease(lease: FileLease): void {
    for (const selector of lease.selectors) {
      const current = scanSelector(this.identity.root, selector);
      for (const [relative, expected] of Object.entries(lease.observed)) {
        if (!selectorMatches(selector, relative)) continue;
        const actual = current.fingerprints[relative] ?? null;
        const identity = current.identities[relative];
        if (actual !== expected || !sameIdentity(lease.identities[relative], identity)) {
          lease.state = "invalid";
          this.touch("lease-invalid", lease.ownerSessionId, [relative]);
          throw new RoomError("foreign_change", `Lease target '${relative}' changed externally.`);
        }
      }
      for (const relative of Object.keys(current.fingerprints)) {
        if (!(relative in lease.observed)) {
          lease.state = "invalid";
          this.touch("lease-invalid", lease.ownerSessionId, [relative]);
          throw new RoomError("foreign_change", `New unowned file '${relative}' appeared under the lease.`);
        }
      }
    }
  }

  private validateActiveLeases(): void {
    for (const lease of Object.values(this.state.leases)) {
      if (!activeLease(lease.state) || lease.state === "orphaned") continue;
      try { this.validateLease(lease); } catch { /* state is already invalid */ }
    }
  }

  private expireCleanLeases(): void {
    const timestamp = Date.now();
    for (const lease of Object.values(this.state.leases)) {
      if (lease.state === "active" && Date.parse(lease.expiresAt) <= timestamp) {
        lease.state = "released";
        this.touch("release", lease.ownerSessionId, lease.selectors);
      }
    }
  }

  private touch(kind: ActivityEntry["kind"], sessionId: string, paths: string[]): void {
    this.state.seq += 1;
    this.state.activity.push({ seq: this.state.seq, kind, sessionId, paths: paths.slice(0, MAX_SELECTOR_COUNT), at: now() });
    this.state.activity = this.state.activity.slice(-this.config.activityLimit);
    this.state.updatedAt = now();
    this.persist();
  }

  private persist(): void {
    persistJson(this.identity.snapshotPath, this.state);
  }

  private writeLock(): void {
    if (this.lockFd < 0) return;
    const lock: LockRecord = { schema: 1, pid: process.pid, connectionId: this.lockConnectionId, epoch: this.state.epoch, heartbeatAt: now() };
    const encoded = Buffer.from(`${JSON.stringify(lock)}\n`, "utf8");
    fs.ftruncateSync(this.lockFd, 0);
    fs.writeSync(this.lockFd, encoded, 0, encoded.length, 0);
    fs.fsyncSync(this.lockFd);
  }
}

function atomicWrite(root: string, relative: string, content: string, expected: string | null, expectedIdentity?: FileIdentity): void {
  const absolute = assertPathChain(root, relative);
  const before = fingerprintAt(root, relative);
  if (before.fingerprint !== expected || !sameIdentity(expectedIdentity, before.identity)) {
    throw new RoomError("foreign_change", "Target changed before atomic mutation.");
  }
  const parent = path.dirname(absolute);
  fs.mkdirSync(parent, { recursive: true });
  assertPathChain(root, relative);
  const existing = fs.existsSync(absolute) ? fs.lstatSync(absolute) : undefined;
  const temporary = path.join(parent, `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: existing?.mode ?? 0o600, flag: "wx" });
  try {
    if (existing) fs.chmodSync(temporary, existing.mode & 0o777);
    const recheck = fingerprintAt(root, relative);
    if (recheck.fingerprint !== expected || !sameIdentity(expectedIdentity, recheck.identity)) {
      throw new RoomError("foreign_change", "Target changed during atomic mutation.");
    }
    fs.renameSync(temporary, absolute);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export class RoomClient {
  readonly identity: ProjectIdentity;
  readonly sessionId: string;
  readonly connectionId: string;
  private readonly coordinator?: Coordinator;
  private readonly channel?: JsonRpcChannel;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private epoch = 0;
  private connected: boolean;
  private reason?: string;

  private constructor(identity: ProjectIdentity, session: RoomSessionInfo, options: { coordinator?: Coordinator; channel?: JsonRpcChannel; reason?: string }) {
    this.identity = identity;
    this.sessionId = session.sessionId;
    this.connectionId = randomUUID();
    this.coordinator = options.coordinator;
    this.channel = options.channel;
    this.connected = Boolean(options.coordinator || options.channel);
    this.reason = options.reason;
  }

  static degraded(identity: ProjectIdentity, session: RoomSessionInfo, reason: string): RoomClient {
    return new RoomClient(identity, session, { reason });
  }

  static async connect(identity: ProjectIdentity, session: RoomSessionInfo, coordinator: Coordinator | undefined, channel: JsonRpcChannel | undefined, config: CollaborationConfig): Promise<RoomClient> {
    const client = new RoomClient(identity, session, { coordinator, channel });
    try {
      const result = await client.request("join", { sessionId: session.sessionId, connectionId: client.connectionId, displayName: session.displayName, pid: session.pid }, true);
      client.epoch = result.epoch;
      client.heartbeatTimer = setInterval(() => { void client.heartbeat(); }, Math.max(500, Math.floor(config.heartbeatMs)));
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get ready(): boolean { return this.connected; }
  get degradedReason(): string | undefined { return this.reason; }

  async snapshot(): Promise<RoomSnapshot> {
    return (await this.request("status", {})).snapshot as RoomSnapshot;
  }

  async claim(payload: Record<string, unknown>): Promise<TaskClaim> {
    return (await this.request("claim", payload)).value as TaskClaim;
  }

  async reserve(paths: string[]): Promise<FileLease> {
    return (await this.request("reserve", { paths })).value as FileLease;
  }

  async release(leaseId: string): Promise<FileLease> {
    return (await this.request("release", { leaseId })).value as FileLease;
  }

  async updatePresence(update: PresenceUpdate): Promise<void> {
    await this.request("heartbeat", update);
  }

  async write(filePath: string, content: string): Promise<unknown> {
    return (await this.request("mutate_write", { path: filePath, content })).value;
  }

  async edit(filePath: string, oldText: string, newText: string): Promise<unknown> {
    return (await this.request("mutate_edit", { path: filePath, oldText, newText })).value;
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.connected) {
      try { await this.request("leave", {}, false); } catch { /* coordinator may already be gone */ }
    }
    this.connected = false;
    this.channel?.close();
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.request("heartbeat", {});
    } catch (error) {
      this.connected = false;
      this.reason = error instanceof Error ? error.message : String(error);
    }
  }

  private async request(method: string, payload: unknown, joining = false): Promise<{ epoch: number; snapshot: RoomSnapshot; value: unknown }> {
    if (!this.connected && !joining) throw new RoomError("room_unavailable", this.reason || "Room coordinator is unavailable.");
    const request: RpcRequest = {
      id: randomUUID(),
      method,
      payload,
      epoch: joining ? 0 : this.epoch,
      sessionId: this.sessionId,
      connectionId: this.connectionId,
    };
    const response = this.coordinator ? await this.coordinator.invoke(request) : await this.channel!.request(request);
    if (!response.ok) throw new RoomError(response.error?.code || "room_error", response.error?.message || "Room request failed.", response.error?.details);
    const result = (response.result ?? {}) as { epoch?: unknown; snapshot?: RoomSnapshot; value?: unknown };
    if (typeof result.epoch === "number") this.epoch = result.epoch;
    return { epoch: this.epoch, snapshot: result.snapshot ?? (result as unknown as RoomSnapshot), value: result.value ?? result };
  }
}

export async function connectRoom(
  cwd: string,
  session: RoomSessionInfo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RoomClient> {
  const config = readCollaborationConfig(env);
  const identity = await resolveProjectIdentity(cwd, env);
  fs.mkdirSync(identity.roomDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const coordinator = new Coordinator(identity, config.config);
    try {
      await coordinator.start();
      return await RoomClient.connect(identity, session, coordinator, undefined, config.config);
    } catch (error) {
      await coordinator.close();
      if (!(error instanceof LockHeldError)) throw error;
    }
    if (takeOverStaleLock(identity, config.config)) continue;
    try {
      const channel = await JsonRpcChannel.connect(identity.socketPath);
      return await RoomClient.connect(identity, session, undefined, channel, config.config);
    } catch (error) {
      const lock = readLock(identity);
      if (lock && processIsAlive(lock.pid)) return RoomClient.degraded(identity, session, "Coordinator is alive but its IPC endpoint is unavailable.");
      if (!takeOverStaleLock(identity, config.config)) return RoomClient.degraded(identity, session, error instanceof Error ? error.message : String(error));
    }
  }
  return RoomClient.degraded(identity, session, "Coordinator takeover is uncertain; mutations are disabled.");
}

export function roomDegradedStatus(client: RoomClient): Record<string, unknown> {
  return {
    ready: client.ready,
    degraded: !client.ready,
    projectKey: client.identity.projectKey,
    root: client.identity.root,
    reason: client.degradedReason,
  };
}
