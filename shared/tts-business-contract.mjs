export const TTS_BUSINESS_ROUTES=Object.freeze({"settings/tts/voices":["GET"]});
export const TTS_BUSINESS_BODY_LIMIT=16*1024;
export function ttsBusinessTarget(route){return Object.hasOwn(TTS_BUSINESS_ROUTES,route)?{route,params:{}}:null;}
export function publicTtsBusinessBody(route,value,status){if(!ttsBusinessTarget(route)||!value||typeof value!=="object"||Array.isArray(value))return null;if(status>=400)return typeof value.error==="string"?{error:value.error}:null;if(!Array.isArray(value.voices))return null;const voices=[];for(const row of value.voices){if(!row||typeof row.id!=="string"||!row.id||typeof row.label!=="string")return null;voices.push({id:row.id,label:row.label});}return{voices};}
