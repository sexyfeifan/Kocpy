import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { scopedArchiveTransferContext } from "../src/main/archive-transfer-context";
import type { ProjectConfig } from "../src/main/types";

const project: ProjectConfig = {
  id: "generated-project", name: "合成归档项目", devices: ["FX3"], volumePrefix: "CARD_",
  projectFolderName: "20261015_Generated", shootingDateStart: "2026-10-15", shootingDateEnd: "2026-10-18",
};
function task(day: string, name = "CARD_001") {
  return new BackupEngine().createTask({ projectId: project.id, projectName: project.name,
    projectFolderName: project.projectFolderName, projectStartDate: project.shootingDateStart,
    sourcePath: "/synthetic/CARD", destinationPaths: ["/synthetic/BACKUP"],
    shootingDate: day, devices: ["FX3"], name, namingTemplate: name, hashAlgorithm: "sha256",
  });
}
const root = "/synthetic/BACKUP/20261015_Generated";

describe("archive context is scoped to the selected source", () => {
  it("uses recorded source dates, never the whole planned shooting cycle", () => {
    const tasks = [task("2026-10-15"), task("2026-10-16")];
    const before = structuredClone(tasks);
    const context = scopedArchiveTransferContext(project, tasks, root, [root]);
    expect(context.archiveName).toBe(project.name);
    expect(context.shootingDate).toBe("2026-10-15 至 2026-10-16");
    expect(context.shootingDate).not.toContain("18");
    expect(context.historicalEvidence.join(" ")).toContain("不证明项目历史素材齐全");
    expect(tasks).toEqual(before);
  });
  it("does not describe one shooting day as the whole project", () => {
    const context = scopedArchiveTransferContext(project, [task("2026-10-15"), task("2026-10-16")], `${root}/20261015`, [root]);
    expect(context.archiveName).toContain("选定目录 20261015");
    expect(context.shootingDate).toBe("2026-10-15");
    expect(context.historicalEvidence.join(" ")).toContain("不宣称包含整个项目");
  });
  it("leaves an unknown subfolder date unrecorded instead of inheriting project plans", () => {
    const context = scopedArchiveTransferContext(project, [task("2026-10-15")], `${root}/20261015/FX3/CARD_001/MEDIA`, [root]);
    expect(context.shootingDate).toBeUndefined();
    expect(context.historicalEvidence.join(" ")).toContain("不以项目计划日期代替");
  });
  it("ignores sibling roots, other projects and unselected historical failures", () => {
    const other = task("2026-10-16"); other.status = "failed";
    const foreign = task("2026-10-15"); foreign.projectId = "another-project";
    const context = scopedArchiveTransferContext(project, [other, foreign], `${root}/20261015`, [root]);
    expect(context.shootingDate).toBeUndefined();
    expect(context.historicalEvidence.join(" ")).not.toContain("状态为 failed");
  });
});
