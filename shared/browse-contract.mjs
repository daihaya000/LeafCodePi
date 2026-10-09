export const BROWSE_ROUTES = Object.freeze({ "browse/dirs": ["GET"], "browse/icon": ["GET", "POST"] });
export const BROWSE_BODY_LIMIT = 256 * 1024;
export function browseTarget(path) { return Object.hasOwn(BROWSE_ROUTES, path) ? {route:path,params:{}} : null; }
const record = v => v && typeof v === "object" && !Array.isArray(v);
const path = v => typeof v === "string" && v.length > 0 && v.length <= 32768 && !v.includes("\0");
const kinds = ["home","oneDrive","desktop","documents","downloads","pictures","project"];
function entry(v, icon = false) {
 if (!record(v) || typeof v.name !== "string" || !path(v.path)) return null;
 if (icon && !["dir","file"].includes(v.kind) || !icon && v.kind !== undefined && !kinds.includes(v.kind)) return null;
 return { name:v.name,path:v.path,...(v.kind !== undefined ? {kind:v.kind} : {}) };
}
function entries(v, icon = false) { if(!Array.isArray(v)) return null; const result=v.map(row=>entry(row,icon)); return result.every(Boolean)?result:null; }
export function publicBrowseBody(route, value, status, method) {
 if (!browseTarget(route) || !record(value)) return null;
 if(status>=400) {
  if(typeof value.error!=="string") return null;
  const out={error:value.error};
  if(route==="browse/dirs") { for(const key of ["path","entries","quickAccess","drives"]) {
   if(value[key]===undefined)continue;
   const projected=key==="path"?(value.path===null?null:path(value.path)?value.path:undefined):entries(value[key]);
   if(projected===undefined || key!=="path"&&projected===null)return null; out[key]=projected;
  } }
  return out;
 }
 if(route==="browse/icon"&&method==="POST") {
  if(typeof value.name!=="string" || typeof value.icon!=="string" || value.icon.length>3000100 || !/^data:image\/(?:png|jpeg|gif|webp|x-icon);base64,[A-Za-z0-9+/]*={0,2}$/.test(value.icon))return null;
  return {icon:value.icon,name:value.name};
 }
 if(!path(value.path) || !(value.parent===null||path(value.parent)))return null;
 const list=entries(value.entries,route==="browse/icon");if(!list)return null;
 const out={path:value.path,parent:value.parent,entries:list};
 if(route==="browse/dirs"){const quick=entries(value.quickAccess),drives=entries(value.drives);if(!quick||!drives)return null;out.quickAccess=quick;out.drives=drives;}
 if(value.error!==undefined){if(typeof value.error!=="string")return null;out.error="ディレクトリを読み込めませんでした";}
 return out;
}
