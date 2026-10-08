export const TASK_CONVERSATION_ROUTES: Readonly<Record<string, readonly string[]>>;
export function taskConversationTarget(path:string):{route:string;params:Record<string,string>}|null;
export function taskConversationBodyLimit(path:string):number;
export function publicTaskConversationBody(route:string,value:unknown,status:number):Record<string,unknown>|null;
