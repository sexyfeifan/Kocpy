import { describe, expect, it } from "vitest";
import { mergeWorkspace, normalizeProjectTemplate, sourceSuggestion, taskFingerprint, templateFromProject, validateWorkspacePackage } from "../src/main/lifecycle";
import type { BackupTask, ProjectConfig } from "../src/main/types";
import { projectCoverage } from "../src/common/task-trust";

const task = (id: string, checksum = "abc"): BackupTask => ({ id, name: "A001", sourcePath: "/Volumes/CARD", devices: ["A"], destinations: [], hashAlgorithm: "sha256", namingTemplate: "A001", status: "completed", totalFiles: 1, completedFiles: 1, totalBytes: 42, transferredBytes: 42, speedBps: 0, eta: 0, currentFile: "", verifyLog: [], projectId: "p1", volumeNumber: 1, fileRecords: [{ name: "clip.mov", relativePath: "DCIM/clip.mov", size: 42, srcChecksum: checksum, destinations: [] }] });
const project: ProjectConfig = { id: "p1", name: "Film", devices: ["A"], volumePrefix: "A_", requiredCopies: 2 };

describe("archive lifecycle and workstation merge", () => {
  it("creates stable content fingerprints and detects duplicate card structures", () => {
    expect(taskFingerprint(task("a"))).toBe(taskFingerprint(task("b")));
    const suggestion = sourceSuggestion([task("a")], { files: [{ relativePath: "DCIM/clip.mov", size: 42 }] });
    expect(suggestion.duplicateTaskId).toBe("a"); expect(suggestion.nextVolume).toBe(2);
  });
  it("merges workstation records without duplicating identical media", () => {
    const merged = mergeWorkspace({ projects: [project], tasks: [task("a")] }, { projects: [{ ...project, namingRule: "custom" }], tasks: [task("b"), task("c", "different")] });
    expect(merged.tasks).toHaveLength(2); expect(merged.result.duplicates).toBe(1); expect(merged.result.tasksAdded).toBe(1); expect(merged.projects[0].namingRule).toBe("custom");
  });
  it("merges append-only project evidence without losing either workstation", () => {
    const local = {
      ...project,
      handoffNotes: [{ id: "local-handoff", at: 1, operator: "A", note: "local" }],
      dailyPlanDecisions: [{
        id: "local-plan", date: "2026-08-25", scheduleKey: "A",
        decision: "expected" as const, operator: "A", at: 1,
      }],
    };
    const remote = {
      ...project,
      namingRule: "remote",
      handoffNotes: [{ id: "remote-handoff", at: 2, operator: "B", note: "remote" }],
      dailyPlanDecisions: [{
        id: "remote-plan", date: "2026-08-26", scheduleKey: "A",
        decision: "unused" as const, operator: "B", at: 2,
      }],
    };
    const merged = mergeWorkspace({ projects: [local], tasks: [] }, { projects: [remote], tasks: [] });
    expect(merged.projects[0].handoffNotes?.map((item) => item.id)).toEqual([
      "local-handoff", "remote-handoff",
    ]);
    expect(merged.projects[0].dailyPlanDecisions?.map((item) => item.id)).toEqual([
      "local-plan", "remote-plan",
    ]);
  });
  it("turns project closeout settings into reusable templates", () => {
    const template = templateFromProject({ ...project, completionActions: ["report", "eject"], volumePrefixByDevice: { A: "CAM_A_" }, checklists: [{ id: "close", phase: "close", label: "交接", required: true }] });
    expect(template.requiredCopies).toBe(2); expect(template.completionActions).toEqual(["report", "eject"]);
    expect(template.volumePrefixByDevice).toEqual({ A: "CAM_A_" });
    expect(template.checklists).toHaveLength(1);
  });
  it("migrates legacy templates into editable custom templates", () => {
    const normalized = normalizeProjectTemplate({ id: "old", name: "旧模板", devices: ["A"], volumePrefix: "A_", requiredCopies: 2, namingRule: "{card}", completionActions: ["report"], createdAt: 1, updatedAt: 1 });
    expect(normalized.kind).toBe("custom");
    expect(normalized.productionType).toBe("custom");
    expect(normalized.volumePrefixByDevice).toEqual({ A: "A_" });
    expect(normalized.revision).toBe(1);
  });
  it("reports logical media volumes instead of inflating repeated attempts", () => {
    const first = task("attempt-a");
    const retry = task("attempt-b");
    first.logicalVolumeId = "logical-a001";
    retry.logicalVolumeId = "logical-a001";
    first.status = "failed";
    retry.status = "completed";
    retry.destinations = [
      {
        id: "copy",
        label: "Copy",
        path: "/tmp/copy",
        verified: true,
        bytesWritten: 42,
      },
    ];
    expect(projectCoverage({ ...project, requiredCopies: 1 }, [first, retry])).toMatchObject({
      recorded: 1,
      verified: 1,
      compliant: 1,
      attention: 0,
    });
  });
  it("accepts older valid records while rejecting malformed imports", () => {
    const old = { application: "Kocpy", schema: 1, projects: [project], tasks: [task("legacy")], templates: [], healthRecords: [] };
    expect(validateWorkspacePackage(old).tasks[0].copyProgress).toBeUndefined();
    expect(() => validateWorkspacePackage({ ...old, tasks: [{ ...task("bad"), status: "owned" }] })).toThrow(/状态或哈希算法/);
    expect(() => validateWorkspacePackage({ ...old, projects: "not-an-array" })).toThrow(/数据列表/);
    expect(() => validateWorkspacePackage({ application: "Elsewhere", schema: 1 })).toThrow(/受支持/);
    expect(() => validateWorkspacePackage({ ...old, schema: 2 })).toThrow(/完整性签名/);
    expect(() => validateWorkspacePackage({ ...old, tasks: [{ ...task("bad-path"), fileRecords: [{ ...task("bad-path").fileRecords[0], relativePath: "../escape.mov" }] }] })).toThrow(/相对路径越界/);
  });
});
