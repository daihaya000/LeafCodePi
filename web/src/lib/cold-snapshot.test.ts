import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readColdIndividualDetail, readColdSnapshotDiagnostics as stats } from "@backend-runtime/event-stream/cold-snapshot";
import { pageTaskMessages } from "@backend-runtime/lib/task-history";
import { snapshotMessages } from "@backend-runtime/lib/pi/snapshot-messages";
const mock = vi.hoisted(() => ({ task: null as any }));
vi.mock("@/lib/store", () => ({ getTask: () => mock.task }));
vi.mock("@/lib/pi/harness", () => ({ getTaskBootstrap: () => ({ ...mock.task, messages: [], isStreaming: false, isCompacting: false }), isTaskRuntimeOwnedElsewhere: () => false }));
vi.mock("@backend-runtime/lib/pi/goal-loop-state", () => ({ readGoalLoopState: () => null }));
let dir: string, path: string;
const encode = (entries: any[], version = 3) => [JSON.stringify({ type: "session", version, id: "s", cwd: dir }), ...entries.map(e => JSON.stringify(e))].join("\n") + "\n";
const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lcp-cold-page-")); path = join(dir, "s.jsonl"); mock.task = { id: "t", kind: "code", directory: dir, sessionId: "s", sessionFile: path, status: "idle", createdAt: "stamp", updatedAt: "stamp" }; vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "backend"); vi.stubEnv("LEAFCODE_PI_DATA_DIR", dir); });
afterEach(() => { expect(stats()).toMatchObject({ coldReaders: 0, coldWaiters: 0, coldDescriptors: 0 }); expect(stats().coldIndexBytes).toBeLessThanOrEqual(8 * 1024 * 1024); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
const read = (options = {}, c = new AbortController()) => readColdIndividualDetail("t", options, c.signal);
it("matches complete readonly projection for branch/compaction/hidden marker/tool output and real row/part IDs", async () => {
  const entries = [user("u", null, "draft"), { type: "message", id: "a", parentId: "u", message: { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] } }, { type: "message", id: "r", parentId: "a", message: { role: "toolResult", timestamp: 3, toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }] } }, user("foreign", "u", "different branch"), { type: "compaction", id: "c", parentId: "r", timestamp: "2026-01-01T00:00:00Z", summary: "summary", tokensBefore: 100, firstKeptEntryId: "u" }, { type: "custom_message", id: "marker", parentId: "c", customType: "leafcode-pi.agent-switch", content: 'switched from "old" to "new"', display: false, details: { previousAgent: "old", nextAgent: "new" }, timestamp: "2026-01-01T00:00:01Z" }, user("latest", "marker", "latest")];
  writeFileSync(path, encode(entries)); const branch = entries.filter(e => e.id !== "foreign");
  const expected = snapshotMessages({ messages: [], agent: { state: {} }, sessionManager: { getLeafId: () => "latest", getBranch: () => branch } } as never);
  const detail = await read(); expect(detail!.messages).toEqual(expected); expect(JSON.stringify(detail)).not.toContain("different branch");
});
it("preserves page history metadata and original msg-N part IDs without retaining old payload", async () => {
  const entries = Array.from({ length: 400 }, (_, i) => user("u" + i, i ? "u" + (i - 1) : null, "row" + i)); writeFileSync(path, encode(entries));
  const detail = await read(), page = pageTaskMessages(detail!.messages); expect(page.messages.length).toBe(150); expect(page.messageHistory).toEqual({ hasMore: true, nextCursor: "u250" }); expect(page.messages[0].parts[0].id).toBe("msg-250-text");
  const before = stats().coldScanBytes; expect((await read())!.messages).toEqual(detail!.messages); expect(stats().coldScanBytes).toBe(before);
});
it("reads a large history with one small page and leaves its bytes/hash unchanged", async () => {
  const entries = Array.from({ length: 1200 }, (_, i) => user("u" + String(i).padStart(32,"0"), i ? "u" + String(i - 1).padStart(32,"0") : null, i < 900 ? "x".repeat(32768) : "tail")); writeFileSync(path, encode(entries));
  const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex"), before = hash(); const detail = await read();
  expect(detail!.messages.length).toBe(150); expect(JSON.stringify(detail).length).toBeLessThan(100000); expect(hash()).toBe(before); expect(stats().coldBufferBytes).toBe(2 * 1024 * 1024);
});
it("restores latest todos/resume and omits history without reviving invalid newer reservations", async () => {
  const data = { version: 1, sessionId: "s", id: "reservation", createdAt: "2026-01-01T00:00:00Z", at: "2026-01-01T00:01:00Z", message: "resume", status: "scheduled" };
  const entries: any[] = [user("u", null, "hello"), { type: "message", id: "todo", parentId: "u", message: { role: "toolResult", toolName: "todowrite", content: [], details: { todos: [{ id: "1", content: "work", status: "pending", priority: "high" }] } } }, { type: "custom", id: "resume", parentId: "todo", customType: "leafcode-session-resume", data }]; writeFileSync(path, encode(entries));
  const detail = await read({ includeMessages: false }); expect(detail!.messages).toEqual([]); expect(detail!.todos![0].content).toBe("work"); expect(detail!.sessionResume).toMatchObject({ id: "reservation" });
  entries.push({ type: "custom", id: "new", parentId: "resume", customType: "leafcode-session-resume", data: {} }); writeFileSync(path, encode(entries)); expect((await read())!.sessionResume).toBeNull();
});
it("invalidates offsets on same-size rewrite and inode replacement", async () => {
  writeFileSync(path, encode([user("u", null, "old")])); expect(JSON.stringify(await read())).toContain("old");
  writeFileSync(path, encode([user("u", null, "new")])); expect(JSON.stringify(await read())).toContain("new");
  rmSync(path); writeFileSync(path, encode([user("v", null, "yes")])); expect((await read())!.messages[0].id).toBe("v");
});
it("refuses legacy/cyclic/oversize lines before SDK opens or session rewrites", async () => {
  for (const [entries, version, status] of [[ [user("u", null, "old")], 1, 409 ], [[user("u", "u", "cycle")], 3, 409], [[user("u", null, "x".repeat(2 * 1024 * 1024))], 3, 413]] as any[]) {
    writeFileSync(path, encode(entries, version)); const before = readFileSync(path); await expect(read()).rejects.toMatchObject({ status }); expect(readFileSync(path).equals(before)).toBe(true);
  }
});
it("pages a 24MiB single user turn by bytes rather than expanding to its beginning", async () => {
  const entries: any[] = [user("u", null, "long task")];
  for (let i = 0; i < 1000; i++) entries.push({ type: "message", id: "a" + i, parentId: i ? "a" + (i - 1) : "u", message: { role: "assistant", timestamp: i + 2, content: [{ type: "text", text: "x".repeat(24576) }] } });
  writeFileSync(path, encode(entries));
  const before = createHash("sha256").update(readFileSync(path)).digest("hex");
  const detail = await read(), page = pageTaskMessages(detail!.messages);
  expect(page.messages.length).toBeGreaterThan(0);
  expect(page.messages.length).toBeLessThan(150);
  expect(page.messages.at(-1)).toMatchObject({ id: "a999", parts: [{ id: "msg-1000-text-0" }] });
  expect(page.messageHistory).toEqual({ hasMore: true, nextCursor: page.messages[0].id });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4 * 1024 * 1024);
  expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
});
it("reduces an oversized initial page even when it has fewer than the configured row count", async () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ type: "message", id: "a" + i, parentId: i ? "a" + (i - 1) : null, message: { role: "assistant", timestamp: i, content: [{ type: "text", text: "x".repeat(600000) }] } }));
  writeFileSync(path, encode(entries));
  const detail = await read();
  expect(detail!.messages.map(m => m.id)).toEqual(["a7", "a8", "a9"]);
  expect(pageTaskMessages(detail!.messages).messageHistory).toEqual({ hasMore: true, nextCursor: "a7" });
});
it("keeps small turn alignment and refuses an unpageable latest tool group instead of returning empty", async () => {
  const entries: any[] = [user("u", null, "small task")];
  for (let i = 0; i < 200; i++) entries.push({ type: "message", id: "a" + i, parentId: i ? "a" + (i - 1) : "u", message: { role: "assistant", timestamp: i, content: [{ type: "text", text: "small" }] } });
  writeFileSync(path, encode(entries));
  expect((await read())!.messages[0].id).toBe("u");
  for (let i = 0; i < 3; i++) entries.push({ type: "message", id: "r" + i, parentId: i ? "r" + (i - 1) : "a199", message: { role: "toolResult", toolName: "read", toolCallId: "call", content: [{ type: "text", text: "x".repeat(1500000) }] } });
  writeFileSync(path, encode(entries));
  await expect(read()).rejects.toMatchObject({ status: 413, code: "COLD_TRANSCRIPT_UNAVAILABLE" });
});
it("recovers without scanning or rewriting an oversized transcript, even without a client cache", async () => {
  writeFileSync(path, encode([user("u", null, "x".repeat(2 * 1024 * 1024))]));
  const before = readFileSync(path), scanned = stats().coldScanBytes;
  await expect(read()).rejects.toMatchObject({ status: 413, code: "COLD_TRANSCRIPT_UNAVAILABLE" });
  const afterFailure = stats().coldScanBytes;
  expect(afterFailure).toBeGreaterThan(scanned);
  expect(await read({ omitTranscript: true })).toMatchObject({ id: "t", sessionId: "s", messages: [], isStreaming: false });
  expect(stats().coldScanBytes).toBe(afterFailure);
  expect(readFileSync(path).equals(before)).toBe(true);
  mock.task.status = "archived";
  expect(await read({ omitTranscript: true })).toMatchObject({ messages: [], isStreaming: false, goalLoop: null });
});
it("refuses oversized files by stat and cancels queued/in-progress scanner slots", async () => {
  writeFileSync(path, encode([user("u", null, "hello")])); const fd = openSync(path, "r+"); ftruncateSync(fd, 512 * 1024 * 1024 + 1); closeSync(fd); await expect(read()).rejects.toMatchObject({ status: 413 });
  writeFileSync(path, encode(Array.from({length:2000},(_,i)=>user("u"+i,i?"u"+(i-1):null,"x".repeat(16384)))));
  const a = new AbortController(), b = new AbortController(), first = read({}, a), second = read({}, b); b.abort(); a.abort(); const results = await Promise.allSettled([first, second]); expect(results.every(r => r.status === "rejected")).toBe(true);
});
it("never repairs a missing final newline and keeps live sessions on the existing snapshot path", async () => {
  writeFileSync(path, encode([user("u", null, "read-only")]).trimEnd()); const before = readFileSync(path); expect((await read())!.messages.length).toBe(1); expect(readFileSync(path).equals(before)).toBe(true);
  (globalThis as any).__leafcodePiHarness = { live: new Map([["t", { leaseLost: false }]]) }; try { expect(await read()).toBeNull(); } finally { delete (globalThis as any).__leafcodePiHarness; }
});
it("restores only page throughput and preserves image parts", async () => {
  const entries: any[] = [user("u", null, "hello"), {type:"message",id:"a",parentId:"u",message:{role:"assistant",timestamp:1000,content:[{type:"text",text:"done"}],usage:{output:12}}}, {type:"custom",id:"timing",parentId:"a",customType:"leafcode-pi.throughput",data:{startedAtMs:1000,firstTokenAtMs:1100,lastTokenAtMs:2100,outputTokens:12}}, {type:"message",id:"image",parentId:"timing",message:{role:"user",timestamp:3000,content:[{type:"image",mimeType:"image/png",data:"iVBORw0KGgo="}]}}];
  writeFileSync(path, encode(entries)); const detail = await read(); expect(detail!.messages.find(m=>m.id==="a")).toMatchObject({outputTokens:12,tokensPerSecond:11}); expect(detail!.messages.at(-1)!.parts[0]).toMatchObject({id:"msg-2-image-0",type:"image"});
});
it("carries persona boundaries outside the page without changing global part ordinals",async()=>{
 const entries:any[]=[{type:"custom_message",id:"switch",parentId:null,customType:"leafcode-pi.agent-switch",display:false,content:"switch",details:{previousAgent:"old",nextAgent:"new"},timestamp:"2026-01-01T00:00:00Z"}];
 for(let i=0;i<400;i++)entries.push(user("u"+i,i?"u"+(i-1):"switch","row"));
 entries.push({type:"message",id:"answer",parentId:"u399",message:{role:"assistant",timestamp:3,content:[{type:"text",text:"answer"}]}});writeFileSync(path,encode(entries));
 const detail=await read();expect(detail!.messages.at(-1)).toMatchObject({id:"answer",agent:"new",parts:[{id:"msg-401-text-0",type:"text",text:"answer"}]});expect(pageTaskMessages(detail!.messages).messageHistory).toEqual({hasMore:true,nextCursor:"u251"});
});
it("rejects invalid UTF-8 rather than silently discarding a valid last JSON record",async()=>{
 const bytes=Buffer.from(encode([user("u",null,"bad")]));bytes[bytes.indexOf("bad")]=255;writeFileSync(path,bytes);await expect(read()).rejects.toMatchObject({status:409});expect(readFileSync(path).equals(bytes)).toBe(true);
});
it("does not relabel an in-flight old-file page with newly switched task metadata",async()=>{
 writeFileSync(path,encode([user("u",null,"old session")]));const pending=read();mock.task={...mock.task,sessionId:"new-session",sessionFile:join(dir,"new.jsonl"),updatedAt:"new-stamp"};const detail=await pending;
 expect(detail).toMatchObject({sessionId:"s",sessionFile:path,updatedAt:"stamp"});expect(detail!.messages[0].id).toBe("u");
});
it("enforces Backend ownership and archived attention semantics", async () => {
  writeFileSync(path, encode([user("u", null, "archived")])); mock.task.status = "archived"; expect(await read()).toMatchObject({isStreaming:false,isCompacting:false,goalLoop:null,sessionResume:null,permissionRequest:null,questionRequest:null});
  vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE", "next"); await expect(read()).rejects.toThrow();
});
