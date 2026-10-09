import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { getBot } from "@/lib/bots";
import { listBotCodeRequests } from "@/lib/pi/bot-code-relay";
import { jsonError } from "@/lib/pi/harness";
import { peekCodeRequestProgress, abortBotCodeRequest } from "../../../../../lib/bot-code";
import { etagJsonResponse } from "@/lib/etag-json";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  assertConfigurationOwner();
  const id = (await params).id;
  if (!getBot(id)) return Response.json({ error: "ボットが見つかりません" }, { status: 404 });
  const listed = listBotCodeRequests(id);
  const requests = await Promise.all(
    listed.map(async (request) => {
      if (!request.codeTaskId) return request;
      // Skip disk/Pi peek for settled requests — outcome/goalLoop report is enough.
      if (request.state === "delivered" || request.state === "cancelled") return request;
      return { ...request, ...(await peekCodeRequestProgress(request.codeTaskId)) };
    }),
  );
  return etagJsonResponse(request, { requests });
}


export async function POST(req: Request,{params}:{params:Promise<{id:string}>}){
 assertConfigurationOwner();
 try {
  const id=(await params).id;if(!getBot(id))return Response.json({error:"ボットが見つかりません"},{status:404});
  const body=await req.json().catch(()=>null) as {action?:unknown;requestId?:unknown}|null;
  if(body?.action!=="abort")return Response.json({error:"Unsupported action"},{status:400});
  if(typeof body.requestId!=="string"||! /^[a-f0-9]{64}$/.test(body.requestId))return Response.json({error:"invalid requestId"},{status:400});
  return Response.json(await abortBotCodeRequest(id,body.requestId));
 }catch(error){const {error:message,status}=jsonError(error);return Response.json({error:status>=500?"Bot Codeの処理結果を確認できません":message},{status});}
}
