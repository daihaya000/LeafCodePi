export const TTS_BUSINESS_ROUTES:Readonly<Record<string,readonly string[]>>;
export const TTS_BUSINESS_BODY_LIMIT:number;
export function ttsBusinessTarget(route:string):{route:string;params:Record<string,string>}|null;
export function publicTtsBusinessBody(route:string,value:unknown,status:number):Record<string,unknown>|null;
