export const TASK_EXECUTION_SETTINGS_ROUTES: Readonly<Record<string, readonly string[]>>;
export const TASK_EXECUTION_SETTINGS_BODY_LIMIT: number;
export function taskExecutionSettingsTarget(path:string):{route:string;params:Record<string,string>}|null;
export function publicTaskExecutionSettingsBody(route:string,value:unknown,status:number):Record<string,unknown>|null;
