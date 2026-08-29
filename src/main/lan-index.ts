import http from "node:http";
import os from "node:os";
import { randomBytes } from "node:crypto";
import type { BackupTask, ProjectConfig } from "./types";
type Snapshot = { projects: ProjectConfig[]; tasks: BackupTask[] };
export class LanProjectIndex {
  private server?: http.Server; private token=""; private startedAt=0;
  constructor(public snapshot:()=>Snapshot|Promise<Snapshot>){}
  async start(port=47821){if(this.server)return this.status();this.token=randomBytes(18).toString("base64url");this.startedAt=Date.now();const server=http.createServer(async(request,response)=>{response.setHeader("Content-Type","application/json; charset=utf-8");response.setHeader("Cache-Control","no-store");if(request.headers.authorization!==`Bearer ${this.token}`){response.statusCode=401;response.end(JSON.stringify({error:"unauthorized"}));return;}if(!request.url?.startsWith("/index")){response.statusCode=404;response.end(JSON.stringify({error:"not_found"}));return;}try{const data=await this.snapshot();response.end(JSON.stringify({schema:1,generatedAt:Date.now(),projects:data.projects.map(({destinationPaths,boundRoots,...project})=>project),tasks:data.tasks.map((task)=>({id:task.id,projectId:task.projectId,name:task.name,shootingDate:task.shootingDate,devices:task.devices,status:task.status,totalFiles:task.totalFiles,totalBytes:task.totalBytes,provenance:task.provenance,destinations:task.destinations.map((item)=>({label:item.label,verified:item.verified,volumeName:item.volumeName}))}))}));}catch(error){response.statusCode=500;response.end(JSON.stringify({error:"snapshot_failed",message:String(error)}));}});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(port,"0.0.0.0",()=>{server.off("error",reject);resolve();});});this.server=server;return this.status();}
  stop(){this.server?.close();this.server=undefined;this.token="";return this.status();}
  status(){const addresses=Object.values(os.networkInterfaces()).flat().filter((item)=>item?.family==="IPv4"&&!item.internal).map((item)=>item!.address),address=this.server?.address();return{active:Boolean(this.server),port:typeof address==="object"&&address?address.port:47821,addresses,token:this.token,startedAt:this.startedAt};}
}
