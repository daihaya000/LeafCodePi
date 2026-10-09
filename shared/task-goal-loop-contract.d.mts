export const TASK_GOAL_LOOP_ROUTES: Readonly<Record<string, readonly string[]>>;
export function taskGoalLoopTarget(path:string):{route:string;params:Record<string,string>}|null;
export function taskGoalLoopBodyLimit(path:string,method?:string):number;
export function publicTaskGoalLoopBody(route:string,value:unknown,status:number,method?:string):Record<string,unknown>|null;
