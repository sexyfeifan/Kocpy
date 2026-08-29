import { describe,expect,it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalogDatabase } from "../src/main/catalog";

describe("catalog write serialization",()=>{
  it("commits overlapping task updates without nested transactions",async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"kocpy-catalog-concurrent-"));
    try{
      const catalog=new CatalogDatabase(root);
      await Promise.all(Array.from({length:20},(_,index)=>catalog.upsertTask({id:`task-${index}`,name:`CARD-${index}`,sourcePath:"/source",devices:[],destinations:[],hashAlgorithm:"sha256",namingTemplate:`CARD-${index}`,status:"completed",totalFiles:0,completedFiles:0,totalBytes:0,transferredBytes:0,speedBps:0,eta:0,currentFile:"",verifyLog:[],fileRecords:[]})));
      expect((await catalog.stats()).tasks).toBe(20);
      expect(await catalog.loadTasks()).toHaveLength(20);
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
});
