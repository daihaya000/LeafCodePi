export const BROWSE_ROUTES: Readonly<Record<string, readonly string[]>>;
export const BROWSE_BODY_LIMIT: number;
export function browseTarget(path: string): {route:string;params:Record<string,string>} | null;
export function publicBrowseBody(route: string,value:unknown,status:number,method?:string):Record<string,any>|null;
