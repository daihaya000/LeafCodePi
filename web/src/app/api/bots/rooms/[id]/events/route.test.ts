import { NextRequest } from "next/server";import { beforeEach,expect,it,vi } from "vitest";
const relay=vi.hoisted(()=>vi.fn());vi.mock("@/lib/live-event-relay",()=>({relayLiveEvents:relay}));
import { GET } from "./route";
const id="11111111-1111-4111-8111-111111111111";
beforeEach(()=>relay.mockReset());
it("GET preserves request, cancellation and opaque route without Next subscriptions",async()=>{const request=new NextRequest("http://localhost/api/bots/rooms/11111111-1111-4111-8111-111111111111/events");const response=new Response(": connected\n\n");relay.mockResolvedValue(response);expect(await GET(request, {params:Promise.resolve({id})})).toBe(response);expect(relay).toHaveBeenCalledWith(request,"bots/rooms/11111111-1111-4111-8111-111111111111/events");});
it("owner failure is returned unchanged, never a local SSE fallback",async()=>{const failure=Response.json({error:"unavailable"},{status:503});relay.mockResolvedValue(failure);expect(await GET(new NextRequest("http://localhost"), {params:Promise.resolve({id})})).toBe(failure);});
