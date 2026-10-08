import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTaskTranscript, resetTaskTranscriptCache } from "./task-transcript";
const read=vi.hoisted(()=>vi.fn());
vi.mock("@backend-runtime/lib/pi/get-task-detail-bounded",()=>({getTaskDetailBounded:read}));
beforeEach(()=>{read.mockReset().mockResolvedValue({messages:[]});resetTaskTranscriptCache();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("owner transcript cache",()=>{
 it("does not reuse without a window",async()=>{await readTaskTranscript("a");await readTaskTranscript("a");expect(read).toHaveBeenCalledTimes(2);expect(read).toHaveBeenCalledWith("a",{readOnly:true});});
 it("coalesces concurrent reads and expires after the window",async()=>{vi.useFakeTimers();await Promise.all([readTaskTranscript("a",{maxAgeMs:3000}),readTaskTranscript("a",{maxAgeMs:3000})]);expect(read).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(3001);await readTaskTranscript("a",{maxAgeMs:3000});expect(read).toHaveBeenCalledTimes(2);});
 it("isolates IDs and caps entries at two",async()=>{for(const id of ["a","b","c","a"])await readTaskTranscript(id,{maxAgeMs:60000});expect(read.mock.calls.map(([id])=>id)).toEqual(["a","b","c","a"]);});
 it("evicts failed reads",async()=>{read.mockRejectedValueOnce(new Error("failed"));await expect(readTaskTranscript("a",{maxAgeMs:3000})).rejects.toThrow("failed");await readTaskTranscript("a",{maxAgeMs:3000});expect(read).toHaveBeenCalledTimes(2);});
 it("refuses Next even for cached data",async()=>{await readTaskTranscript("a",{maxAgeMs:3000});vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");await expect(readTaskTranscript("a",{maxAgeMs:3000})).rejects.toThrow("owned by Backend");expect(read).toHaveBeenCalledTimes(1);});
});
