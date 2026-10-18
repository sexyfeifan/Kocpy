import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { BackupEngine, hashFile } from "../src/main/backup/BackupEngine";
import { relinkProxySources } from "../src/main/proxy-source-relink";
import type { ProxyJob } from "../src/main/types";

describe("audited frozen proxy-source relocation", () => {
  it("rebinds only matching unstarted jobs, rehashes new files and preserves completed/running evidence", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-relink-")));
    try {
      const file = path.join(root, "clip.mov"); await fs.writeFile(file, "generated media");
      const checksum = await hashFile(file, "sha256");
      const task = new BackupEngine().createTask({ name: "generated", sourcePath: "/synthetic/card", destinationPaths: [root],
        hashAlgorithm: "sha256", devices: [], shootingDate: "", namingTemplate: "card" });
      task.fileRecords = [{ name: "clip.mov", relativePath: "clip.mov", size: 15, srcChecksum: checksum, destinations: [] }];
      const job = { id: "proxy", name: "generated", input: "/synthetic/offline/clip.mov", outputDir: root,
        format: "h264", resolution: "source", status: "paused", progress: 0, createdAt: 1,
        sourceTaskId: task.id, sourceRelativePath: "clip.mov", sourceEvidence: { taskId: task.id, relativePath: "clip.mov",
          path: "/synthetic/offline/clip.mov", bytes: 15, modifiedAt: 1, hashAlgorithm: "sha256", checksum, capturedAt: 1, media: {} },
      } as ProxyJob;
      const complete = { ...job, id: "complete", status: "completed" as const }, running = { ...job, id: "running", status: "running" as const };
      const before = structuredClone(job), jobs = await relinkProxySources([job, complete, running], task, "/synthetic/offline", root, "Synthetic DIT");
      expect(jobs[0].input).toBe(file); expect(jobs[0].status).toBe("paused");
      expect(jobs[0].sourceEvidence?.checksum).toBe(checksum);
      expect(jobs[0].sourceRelinks?.[0]).toMatchObject({ from: job.input, to: file, operator: "Synthetic DIT" });
      expect(jobs[1]).toBe(complete); expect(jobs[2]).toBe(running); expect(job).toEqual(before);
      const legacy = { ...job, sourceEvidence: undefined };
      expect((await relinkProxySources([legacy], task, "/synthetic/offline", root, "Synthetic DIT"))[0].input).toBe(legacy.input);
      await fs.writeFile(file, "changed media!!");
      await expect(relinkProxySources([job], task, "/synthetic/offline", root, "Synthetic DIT")).rejects.toThrow("冻结源证据");
      expect(job).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
