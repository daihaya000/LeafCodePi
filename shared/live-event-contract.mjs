export const LIVE_EVENT_PATH="/internal/live-events";
export const LIVE_EVENT_HEADERS=Object.freeze(["content-type","cache-control","x-content-type-options","x-accel-buffering"]);
export function liveEventTarget(route){
 if(route==="bots/events")return{route,id:"",kind:"bots"};
 const match=/^bots\/rooms\/([^/]+)\/events$/.exec(route);if(!match)return null;
 let id;try{id=decodeURIComponent(match[1]);}catch{return null;}
 if(id.length>512||!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return null;
 return{route:"bots/rooms/[id]/events",id,kind:"room"};
}
