import {createServer,type Socket} from "node:net";
import {createInterface} from "node:readline";
import {chmodSync,existsSync,lstatSync,unlinkSync,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {createConnection} from "node:net";
import {createTaskEngine} from "./task-engine.ts";
import {taskSocketPath} from "./task-client.ts";
import {VERSION} from "../config.ts";

delete process.env.BITTUNE_EMBEDDED_HOST;
delete process.env.BITTUNE_TASK_SCOPE_FILE;
const path=taskSocketPath();
const bundle_sha256=createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
if(existsSync(path)){
 const stat=lstatSync(path);if(!stat.isSocket()||stat.uid!==process.getuid?.())throw new Error("不能替换其他用户的任务连接。");
 const alive=await new Promise<boolean>(resolve=>{const c=createConnection(path);c.once("connect",()=>{c.destroy();resolve(true);});c.once("error",()=>resolve(false));});
 if(alive)process.exit(0);unlinkSync(path);
}
process.umask(0o077);
const engine=await createTaskEngine(),clients=new Set<Socket>();let inflight=0,closing=false;
const server=createServer(socket=>{const controllers=new Map<string,AbortController>();socket.on("close",()=>{for(const controller of controllers.values())controller.abort();});clients.add(socket);socket.on("close",()=>clients.delete(socket));socket.on("error",()=>{});
 createInterface({input:socket,crlfDelay:Infinity}).on("line",line=>{void(async()=>{let id:unknown;
  try{const req=JSON.parse(line);id=req.id;
   if(req.method==="cancel_request"){controllers.get(String(req.params?.request_id))?.abort();socket.write(JSON.stringify({id,result:{cancelled:true}})+"\n");return;}
   if(req.method==="engine_status"){socket.write(JSON.stringify({id,result:{protocol:1,version:VERSION,bundle_sha256,pid:process.pid,active:engine.isActive(),inflight}})+"\n");return;}
   if(req.method==="engine_shutdown"){
    if(engine.isActive()||inflight)throw Object.assign(new Error("任务或请求仍在执行，不能停止共享任务进程。"),{code:"workspace_busy"});
    socket.write(JSON.stringify({id,result:{stopped:true}})+"\n",()=>void shutdown());return;
   }
   if(closing)throw new Error("任务进程正在退出。");
   const controller=new AbortController();controllers.set(String(id),controller);inflight++;try{const result=await engine.dispatch(req.method,req.params || {},controller.signal);socket.write(JSON.stringify({id,result})+"\n");}finally{inflight--;controllers.delete(String(id));}
  }catch(e:any){socket.write(JSON.stringify({id,error:{code:e.code || "task_error",message:e.message}})+"\n");}
 })();});
});
server.on("error",e=>{if((e as NodeJS.ErrnoException).code==="EADDRINUSE")process.exit(0);throw e;});
server.listen(path,()=>chmodSync(path,0o600));
async function shutdown(){if(closing)return;closing=true;await engine.shutdown();for(const c of clients)c.end();server.close(()=>{if(existsSync(path))unlinkSync(path);process.exit(0);});}
process.on("SIGTERM",()=>void shutdown());process.on("SIGINT",()=>void shutdown());
