import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectManifestNames, projectReportCsv, publishProjectArchive } from "../src/main/project-report-artifacts";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { generateMhl } from "../src/main/backup/ManifestGenerator";
import { generateProjectReport } from "../src/main/backup/ReportGenerator";
import type { ProjectConfig, BackupTask } from "../src/main/types";

function task(): BackupTask {
  const result = new BackupEngine().createTask({ name: "A001", sourcePath: "/synthetic/card",
    destinationPaths: ["/synthetic/backup"], hashAlgorithm: "sha256", namingTemplate: "A001",
    devices: ["FX3"], shootingDate: "2026-10-15" });
  result.fileRecords = ["before.mov", "after.mov", "unknown.idx"].map(relativePath => ({
    name: relativePath, relativePath, size: 1, srcChecksum: "a".repeat(64), destinations: [],
  }));
  result.totalFiles = 3; result.totalBytes = 3;
  result.dateAllocation = { schemaVersion: 1, sourceTaskId: result.id, sourceEvidenceDigest: "a".repeat(64), generatedAt: 1, updatedAt: 2,
    groups: [
      { id: "before", label: "before", relativePaths: ["before.mov"], files: 1, bytes: 1, suggestionBasis: "embedded-media", suggestionConfidence: "review", evidence: [], assignedDate: "2026-10-15", confirmedBy: "Synthetic DIT", confirmedAt: 2 },
      { id: "after", label: "after", relativePaths: ["after.mov"], files: 1, bytes: 1, suggestionBasis: "embedded-media", suggestionConfidence: "review", evidence: [], assignedDate: "2026-10-16", confirmedBy: "Synthetic DIT", confirmedAt: 2 },
    ] };
  return result;
}
const project = { id: "synthetic-project", name: "Synthetic project", shootingDateStart: "2026-10-15",
  shootingDateEnd: "2026-10-16", devices: ["FX3"], volumePrefix: "FX3_", destinationPaths: [], requiredCopies: 1 } as ProjectConfig;

describe("project artifact identity and shooting-day meaning", () => {
  it("uses confirmed per-file days and leaves unknown rows unresolved instead of task-day inference", async () => {
    const value = task(), html = (await generateProjectReport(project, [value])).toString();
    expect(html).toMatch(/2026-10-16<br>已确认归属<\/td><td>FX3<\/td><td>A001<\/td><td>after.mov/);
    expect(html).toMatch(/待确认归属<\/td><td>FX3<\/td><td>A001<\/td><td>unknown.idx/);
    const csv = projectReportCsv(project, [value]);
    expect(csv).toContain("任务原始拍摄日");
    expect(csv).toContain('"2026-10-15；2026-10-16","1"');
    expect(value.shootingDate).toBe("2026-10-15");
  });
  it("preserves distinct UUIDs sharing a display prefix and rejects duplicate identities", async () => {
    const first = task(), second = task();
    first.id = "abcdef00-0000-4000-8000-000000000001";
    second.id = "abcdef11-1111-4000-8000-000000000002";
    const names = projectManifestNames([first, second]);
    expect(new Set(names).size).toBe(2);
    expect(() => projectManifestNames([first, first])).toThrow("重复");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-project-package-"));
    try {
      const folder = await publishProjectArchive(root, "package", [first, second].map((value, index) => ({
        name: names[index], write: file => fs.writeFile(file, generateMhl(value, 0), { flag: "wx" }),
      })));
      const checksums = await fs.readFile(path.join(folder, "SHA256SUMS.txt"), "utf8");
      expect(checksums.trim().split("\n")).toHaveLength(2);
      for (const name of names) expect(checksums).toContain(`${createHash("sha256").update(await fs.readFile(path.join(folder, name))).digest("hex")}  ${name}`);
      expect(JSON.parse(await fs.readFile(path.join(folder, "KOCPY_ARCHIVE_COMPLETE.json"), "utf8")).files).toEqual(names);
      await expect(publishProjectArchive(root, "package", [])).rejects.toThrow("已存在");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("does not publish a completion marker after failure, or permit duplicate artifact names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-project-package-failure-"));
    try {
      const writer = { name: "one", write: (file: string) => fs.writeFile(file, "kept", { flag: "wx" }) };
      await expect(publishProjectArchive(root, "duplicate", [writer, writer])).rejects.toThrow("不唯一");
      expect(await fs.readdir(root)).toEqual([]);
      await expect(publishProjectArchive(root, "failed", [writer,
        { name: "two", write: async () => { throw new Error("synthetic disk failure"); } }])).rejects.toThrow("未完整生成");
      expect(await fs.readFile(path.join(root, "failed/one"), "utf8")).toBe("kept");
      await expect(fs.access(path.join(root, "failed/KOCPY_ARCHIVE_COMPLETE.json"))).rejects.toThrow();
      expect(await fs.readdir(path.join(root, "failed"))).toContain("KOCPY_ARCHIVE_INCOMPLETE.json");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("stops if the newly reserved package directory is replaced by a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-project-package-binding-"));
    try {
      await fs.mkdir(path.join(root, "other"));
      await fs.writeFile(path.join(root, "other/sentinel"), "do not touch", { flag: "wx" });
      await expect(publishProjectArchive(root, "package", [{ name: "report", write: async file => {
        await fs.writeFile(file, "generated", { flag: "wx" });
        await fs.rename(path.dirname(file), path.join(root, "retained-original"));
        await fs.symlink(path.join(root, "other"), path.dirname(file));
      } }])).rejects.toThrow("未完整生成");
      expect(await fs.readdir(path.join(root, "other"))).toEqual(["sentinel"]);
      expect(await fs.readFile(path.join(root, "other/sentinel"), "utf8")).toBe("do not touch");
      expect(await fs.readdir(path.join(root, "retained-original"))).toContain("KOCPY_ARCHIVE_INCOMPLETE.json");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
