import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs"; import os from "node:os"; import path from "node:path";
import { builtInProductionTemplates, importExistingBackup, previewExistingBackup, projectCoverage } from "../src/main/production-lifecycle";
const project:any={id:"p",name:"Film",devices:["FX3"],volumePrefix:"A_",requiredCopies:2,expectedVolumes:4,managedSince:"2026-08-01"};
describe("0.1.0 production lifecycle",()=>{
  it("recognizes and safely baselines an existing backup",async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),"kocpy-import-"));try{await fs.mkdir(path.join(root,"20260801_FX3_CARD01"));await fs.writeFile(path.join(root,"20260801_FX3_CARD01","clip.mov"),"media");const preview=await previewExistingBackup(root);expect(preview.files).toBe(1);const task=await importExistingBackup(project,root,"external-baseline");expect(task.provenance).toBe("external-baseline");expect(task.confidence).toBe("baseline");expect(task.status).toBe("completed");}finally{await fs.rm(root,{recursive:true,force:true});}});
  it("reports coverage without pretending unknown history is complete",()=>{const coverage=projectCoverage(project,[{projectId:"p",provenance:"external-baseline",destinations:[{verified:true,path:"a"}]} as any]);expect(coverage.recorded).toBe(1);expect(coverage.compliant).toBe(0);expect(coverage.coveragePercent).toBe(25);});
  it("ships five production templates",()=>expect(builtInProductionTemplates()).toHaveLength(5));
});
