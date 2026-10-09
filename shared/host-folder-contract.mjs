export const HOST_FOLDER_PATH = "/browse/select-folder";
export const HOST_FOLDER_HEADER = "x-leafcode-host-folder";
export const HOST_FOLDER_BODY_LIMIT = 4096;
export function publicHostFolderBody(value,status) {
 if(!value || typeof value!=="object" || Array.isArray(value))return null;
 if(status===501)return{error:"フォルダ選択にHostが未対応です",execution:"not-started"};
 if(status>=400) {
  if(typeof value.error!=="string")return null;
  return {error:status>=500?"フォルダ選択の結果を確認できません":value.error,...(status>=500?{execution:"unknown"}:{})};
 }
 if(value.cancelled===true)return{cancelled:true};
 return typeof value.path==="string"&&value.path.length>0&&value.path.length<=32768&&!value.path.includes("\0")?{path:value.path}:null;
}
