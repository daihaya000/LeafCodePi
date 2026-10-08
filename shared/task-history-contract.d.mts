export const TASK_HISTORY_ROUTES: Readonly<Record<string,readonly string[]>>;
export const TASK_HISTORY_BODY_LIMIT: number;
export function taskHistoryTarget(path:string):{route:string;params:Record<string,string>}|null;
export function publicTaskHistoryBody(route:string,value:unknown,status:number):Record<string,unknown>|null;
