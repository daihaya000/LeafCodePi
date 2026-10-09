export const TASK_SESSION_ROUTES: Readonly<Record<string, readonly string[]>>;
export const TASK_SESSION_BODY_LIMIT: number;
export function taskSessionTarget(path:string):{route:string;params:Record<string,string>}|null;
export function publicTaskSessionBody(route:string,value:unknown,status:number):Record<string,unknown>|null;
