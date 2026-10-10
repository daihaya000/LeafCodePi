import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTaskTranscript, readTaskTranscriptPage, resetTaskTranscriptCache } from "./task-transcript";
const read=vi.hoisted(()=>vi.fn());
const task=vi.hoisted(()=>vi.fn());
const disk=vi.hoisted(()=>vi.fn());
const admit=vi.hoisted(()=>vi.fn());
vi.mock("@backend-runtime/lib/session-history-page",()=>({readSessionHistoryPage:disk}));
vi.mock("@backend-core/session-memory-guard.mjs",()=>({assertSessionLoadAllowed:admit}));
vi.mock("@/lib/store",()=>({getTask:task}));
vi.mock("@backend-runtime/lib/pi/get-task-detail-bounded",()=>({getTaskDetailBounded:read}));
beforeEach(()=>{read.mockReset().mockResolvedValue({messages:[]});task.mockReset();disk.mockReset();admit.mockReset();resetTaskTranscriptCache();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("owner transcript cache",()=>{
 it("rejects stale cursors for tasks without a persisted transcript",async()=>{task.mockReturnValue({id:"a",status:"idle",sessionFile:null});await expect(readTaskTranscriptPage("a","missing",20)).rejects.toThrow("履歴カーソルが無効");expect(read).not.toHaveBeenCalled();});
 it("aborts before live hydration or task-store reads",async()=>{const controller=new AbortController();controller.abort();await expect(readTaskTranscriptPage("a",null,20,controller.signal)).rejects.toMatchObject({name:"AbortError"});expect(task).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();});
 it("never admits a legacy fallback after cancellation during the disk read",async()=>{const controller=new AbortController();task.mockReturnValue({status:"archived",sessionFile:"legacy.jsonl"});disk.mockImplementation(async()=>{controller.abort();throw{code:"SESSION_INDEX_LEGACY"};});await expect(readTaskTranscriptPage("a",null,20,controller.signal)).rejects.toMatchObject({name:"AbortError"});expect(admit).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();});
 it("discards a legacy snapshot when the request is cancelled while hydrating",async()=>{const controller=new AbortController();task.mockReturnValue({status:"archived",sessionFile:"legacy.jsonl"});disk.mockRejectedValue({code:"SESSION_INDEX_LEGACY"});read.mockImplementation(async()=>{controller.abort();return{messages:[]};});await expect(readTaskTranscriptPage("a",null,20,controller.signal)).rejects.toMatchObject({name:"AbortError"});});
 it("preserves nullish disk failure reasons without substituting a TypeError",async()=>{task.mockReturnValue({status:"archived",sessionFile:"history.jsonl"});disk.mockRejectedValue(null);await expect(readTaskTranscriptPage("a",null,20)).rejects.toBeNull();expect(read).not.toHaveBeenCalled();});
 it("reads original pages for a live memory-only projection instead of its placeholders",async()=>{
  const globals=globalThis as typeof globalThis&{__leafcodePiHarness?:unknown},previous=globals.__leafcodePiHarness;
  globals.__leafcodePiHarness={live:new Map([["a",{session:{sessionManager:{memorySlimmed:true}}}]])};
  task.mockReturnValue({id:"a",status:"idle",sessionFile:"original.jsonl"});
  const page={messages:[{id:"bookmark",parts:[{type:"text",text:"original"}]}],messageHistory:{hasMore:true,nextCursor:"bookmark"}};
  disk.mockResolvedValue(page);
  try{expect(await readTaskTranscriptPage("a","cursor",20)).toEqual(page);expect(disk).toHaveBeenCalledWith("original.jsonl","cursor",20,undefined);expect(read).not.toHaveBeenCalled();}
  finally{if(previous===undefined)delete globals.__leafcodePiHarness;else globals.__leafcodePiHarness=previous;}
 });
 it("does not reuse without a window",async()=>{await readTaskTranscript("a");await readTaskTranscript("a");expect(read).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledWith("a",{readOnly:true});});
 it("coalesces concurrent reads and expires after the window",async()=>{vi.useFakeTimers();await Promise.all([readTaskTranscript("a",{maxAgeMs:3000}),readTaskTranscript("a",{maxAgeMs:3000})]);expect(read).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(3001);await readTaskTranscript("a",{maxAgeMs:3000});expect(read).toHaveBeenCalledTimes(2);});
 it("isolates IDs and caps entries at two",async()=>{for(const id of ["a","b","c","a"])await readTaskTranscript(id,{maxAgeMs:60000});expect(read.mock.calls.map(([id])=>id)).toEqual(["a","b","c","a"]);});
 it("evicts failed reads",async()=>{read.mockRejectedValueOnce(new Error("failed"));await expect(readTaskTranscript("a",{maxAgeMs:3000})).rejects.toThrow("failed");await readTaskTranscript("a",{maxAgeMs:3000});expect(read).toHaveBeenCalledTimes(2);});
 it("refuses Next even for cached data",async()=>{await readTaskTranscript("a",{maxAgeMs:3000});vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");await expect(readTaskTranscript("a",{maxAgeMs:3000})).rejects.toThrow("owned by Backend");expect(read).toHaveBeenCalledTimes(1);});
});
