import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({activeGoalLoopTaskIds:vi.fn()}));
vi.mock("@/lib/pi/harness",()=>mocks);
import { GET } from "@backend-runtime/json-business/handlers/goal-loop/active/route";
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","backend");mocks.activeGoalLoopTaskIds.mockReturnValue([]);});
afterEach(()=>vi.unstubAllEnvs());
it("reads the owner's active inventory, including no loops",async()=>{mocks.activeGoalLoopTaskIds.mockReturnValue(["task-1","bot:fixture"]);expect(await(await GET()).json()).toEqual({active:2,taskIds:["task-1","bot:fixture"]});mocks.activeGoalLoopTaskIds.mockReturnValue([]);expect(await(await GET()).json()).toEqual({active:0,taskIds:[]});});
it("does not disguise owner failure as an empty inventory or expose its exception",async()=>{mocks.activeGoalLoopTaskIds.mockImplementation(()=>{throw new Error("PRIVATE");});const response=await GET();expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");});
it("Next cannot enumerate the owner's runtime or files",async()=>{vi.stubEnv("LEAFCODE_PI_PROCESS_ROLE","next");await expect(GET()).rejects.toThrow("owned by Backend");expect(mocks.activeGoalLoopTaskIds).not.toHaveBeenCalled();});
