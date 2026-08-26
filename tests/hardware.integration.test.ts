import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import type { BackupTask } from "../src/main/types";
const destinations: string[] = (() => { try { return JSON.parse(process.env.KOCPY_HARDWARE_DESTINATIONS || "[]"); } catch { return []; } })();
const enabled = destinations.length > 0;
function wait(engine: BackupEngine) { return new Promise<BackupTask>((resolve, reject) => { const timer=setTimeout(()=>reject(new Error("hardware test timeout")),30*60_000); engine.once("settled",(task)=>{clearTimeout(timer);resolve(task);}); }); }
describe.skipIf(!enabled)("Opt-in mounted-volume stress verification", () => {
  it("copies one large file and 1500 small files to every supplied mounted volume", async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-hardware-source-"));
    try {
      const large = await fs.open(path.join(source,"large-camera-clip.bin"),"w"); try { const block=Buffer.alloc(1024*1024,0xa5); for(let i=0;i<256;i++) await large.write(block); } finally { await large.close(); }
      await fs.mkdir(path.join(source,"SMALL")); await Promise.all(Array.from({length:1500},(_,i)=>fs.writeFile(path.join(source,"SMALL",`clip-${String(i).padStart(5,"0")}.dat`),Buffer.from(`frame-${i}`))));
      const engine=new BackupEngine(), task=engine.createTask({name:"hardware-stress",sourcePath:source,destinationPaths:destinations,hashAlgorithm:"sha256",namingTemplate:"hardware-stress",devices:[],shootingDate:"",copyMode:"normal"});
      const done=wait(engine); engine.startTask(task.id); const result=await done;
      expect(result.status).toBe("completed"); expect(result.totalFiles).toBe(1501); expect(result.destinations.every((d)=>d.verified)).toBe(true);
    } finally { await fs.rm(source,{recursive:true,force:true}); }
  }, 30 * 60_000);
});
