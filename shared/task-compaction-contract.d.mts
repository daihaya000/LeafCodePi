export const TASK_COMPACTION_ROUTES: Readonly<Record<string, readonly string[]>>;
export const TASK_COMPACTION_BODY_LIMIT: number;
export function taskCompactionTarget(path:string):{route:string;params:Record<string,string>}|null;
export function taskCompactionBodyLimit(path:string):number;
export function taskCompactionTimeout(path:string):number;
export function publicTaskCompactionBody(route:string,value:unknown,status:number):Record<string,unknown>|null;
