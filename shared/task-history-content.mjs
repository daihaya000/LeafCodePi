/** Pure history projection shared by the owner and existing UI clients. */
export function stripImageDataFromMessages(messages) {
 return messages.map(message=>{
  let changed=false;
  const parts=message.parts.map(part=>{
   if(part.type!=="image"||!part.url.startsWith("data:"))return part;
   changed=true;const filename=part.filename??`${part.id}.${part.mime.split("/")[1]??"png"}`;
   return {...part,url:"",filename};
  });
  return changed?{...message,parts}:message;
 });
}
