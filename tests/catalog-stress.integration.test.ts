import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalogDatabase } from "../src/main/catalog";

const count=Number(process.env.KOCPY_LARGE_TEST||0);
describe.skipIf(!count)("large catalog",()=>{
  it(`indexes and searches ${count.toLocaleString()} files`,async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),"kocpy-large-catalog-"));try{const db=new CatalogDatabase(root),fileRecords=Array.from({length:count},(_,index)=>({name:`CLIP_${String(index).padStart(7,"0")}.mov`,relativePath:`DAY01/A/CARD01/CLIP_${String(index).padStart(7,"0")}.mov`,size:1024+index,srcChecksum:String(index).padStart(64,"0"),destinations:[{path:`/Volumes/ARCHIVE/DAY01/A/CARD01/CLIP_${String(index).padStart(7,"0")}.mov`,checksum:String(index).padStart(64,"0"),verified:true}]})),task:any={id:"stress",projectId:"stress-project",name:"CARD01",shootingDate:"2026-08-29",status:"completed",provenance:"kocpy-transfer",createdAt:1,totalFiles:count,totalBytes:fileRecords.reduce((sum,item)=>sum+item.size,0),fileRecords};const started=Date.now();await db.rebuild([task],[{id:"stress-project",name:"Stress",devices:["A"],volumePrefix:"A_"} as any]);const rows=await db.pageFiles({query:`CLIP_${String(count-1).padStart(7,"0")}`,limit:10});expect(rows).toHaveLength(1);expect((await db.stats()).files).toBe(count);console.log(JSON.stringify({files:count,durationMs:Date.now()-started,databaseBytes:(await fs.stat(path.join(root,"catalog.sqlite"))).size}));}finally{await fs.rm(root,{recursive:true,force:true});}},Math.max(120000,count*2));
});
