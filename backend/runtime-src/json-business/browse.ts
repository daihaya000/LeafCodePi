import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { webUiAuthRequired } from "../lib/webui-auth";
import { BROWSE_BODY_LIMIT, publicBrowseBody } from "@shared/browse-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import type { JsonBusinessInput } from "./index";
import * as dirs from "./handlers/browse/dirs/route";
import * as icon from "./handlers/browse/icon/route";
export async function dispatchBrowseRequest(input:JsonBusinessInput,request:Request):Promise<JsonBusinessResult>{
 assertConfigurationOwner();
 if(webUiAuthRequired()&&!input.authorized)return{status:401,headers:{},body:{error:"Unauthorized"}};
 if((input.body?.byteLength??0)>BROWSE_BODY_LIMIT)return{status:413,headers:{},body:{error:"Request body is too large"}};
 try {
  const handler=(input.route==="browse/dirs"?dirs:icon) as unknown as Record<string,(r:Request)=>Promise<Response>>;
  const response=await handler[input.method](request), body=await response.json(), projected=publicBrowseBody(input.route,body,response.status,input.method);
  return projected?{status:response.status,headers:{"cache-control":"no-store, private"},body:projected}:{status:503,headers:{},body:{error:"Backendの参照結果を確認できません"}};
 } catch {return{status:503,headers:{},body:{error:"Backendの参照結果を確認できません"}};}
}
