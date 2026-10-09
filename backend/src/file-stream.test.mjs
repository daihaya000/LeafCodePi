import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { writeFileStream } from "./file-stream.mjs";
class Socket extends EventEmitter {
  destroyed=false; writes=0; writableLength=0;
  writeHead(){} write(){this.writes++;return false;}
  destroy(){this.destroyed=true;this.emit("close");} end(){this.emit("finish");}
}
test("stalled drain cancels the source and removes every listener",async()=>{
 const socket=new Socket(),controller=new AbortController();let cancelled=0;
 const stream=new ReadableStream({pull(output){output.enqueue(new Uint8Array(65536));},cancel(){cancelled++;}});
 // Keep the process alive while the production timer intentionally uses unref.
 const keep=setInterval(()=>{},1000);try{await writeFileStream(socket,new Response(stream),controller.signal,"GET",{stallMs:20});}finally{clearInterval(keep);}
 assert.equal(socket.destroyed,true);assert.equal(cancelled,1);assert.equal(socket.listenerCount("drain"),0);assert.equal(socket.listenerCount("close"),0);assert.equal(socket.writes,1);
});
test("disconnect before acquisition still cancels an unread body",async()=>{
 const socket=new Socket(),controller=new AbortController();controller.abort();let cancelled=0;
 await writeFileStream(socket,new Response(new ReadableStream({cancel(){cancelled++;}})),controller.signal,"GET");
 assert.equal(cancelled,1);assert.equal(socket.writes,0);
});
test("chunk budget prevents an unexpected whole-file source buffer entering the socket",async()=>{
 const socket=new Socket(),controller=new AbortController();let cancelled=0;
 await writeFileStream(socket,new Response(new ReadableStream({start(output){output.enqueue(new Uint8Array(65537));},cancel(){cancelled++;}})),controller.signal,"GET");
 assert.equal(socket.destroyed,true);assert.equal(socket.writes,0);assert.equal(cancelled,1);
});
