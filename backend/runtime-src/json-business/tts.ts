import { assertConfigurationOwner } from "@backend-core/configuration-command.mjs";
import { publicTtsBusinessBody } from "@shared/tts-business-contract.mjs";
import type { JsonBusinessResult } from "@shared/json-business-contract.mjs";
import type { JsonBusinessInput } from "./index";
import * as voices from "./handlers/settings/tts/voices/route";
export async function dispatchTtsBusinessRequest(input:JsonBusinessInput,request:Request):Promise<JsonBusinessResult>{
 assertConfigurationOwner();try{const response=await voices.GET(request),body=publicTtsBusinessBody(input.route,await response.json(),response.status);return body?{status:response.status,headers:{"cache-control":"private, no-store"},body}:{status:503,headers:{},body:{error:"音声設定の結果を確認できません"}};}catch{return{status:503,headers:{},body:{error:"音声設定の結果を確認できません"}};}
}
