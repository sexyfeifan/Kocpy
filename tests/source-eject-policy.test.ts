import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { appendProjectRuleSnapshot } from "../src/main/project-evidence";
import { ejectCopyRequirement, qualifiedForEjection } from "../src/main/source-eject-policy";
import type { ProjectConfig } from "../src/main/types";

function fixture(requiredCopies = 2) {
  const project = appendProjectRuleSnapshot(undefined, { id: "generated-project", name: "Synthetic", volumePrefix: "A_",
    devices: ["FX3"], shootingDateStart: "2026-10-15", requiredCopies } as ProjectConfig, { operator: "Synthetic DIT" });
  const task = new BackupEngine().createTask({ name: "synthetic", sourcePath: "/synthetic/card",
    destinationPaths: ["/synthetic/target"], hashAlgorithm: "sha256", devices: ["FX3"],
    shootingDate: "2026-10-15", namingTemplate: "card", projectId: project.id });
  task.status = "completed"; task.destinations[0].verified = true;
  task.projectRuleSnapshotId = project.activeRuleSnapshotId;
  return { task, project };
}
describe("shared qualified-ejection policy", () => {
  it("uses the frozen project requirement and never upgrades unknown topology", () => {
    const { task, project } = fixture(2);
    project.requiredCopies = 1;
    expect(ejectCopyRequirement(task, project)).toBe(2);
    expect(qualifiedForEjection(task, project)).toBe(false);
    task.destinations.push({ ...task.destinations[0], id: "two", path: "/synthetic/two" });
    expect(qualifiedForEjection(task, project)).toBe(false);
    task.destinations.forEach((destination, index) => {
      destination.volumeUuid = `synthetic-${index}`;
      destination.storageEvidence = { kind: "local-physical", volumeUuid: destination.volumeUuid,
        assessmentId: "same-fresh-observation", checkedAt: 1, domains: [`disk${index + 1}`], reason: "generated" };
    });
    expect(qualifiedForEjection(task, project)).toBe(true);
  });
  it("fails closed on missing, duplicate or digest-modified frozen rules", () => {
    const { task, project } = fixture(1);
    expect(qualifiedForEjection(task, project)).toBe(true);
    expect(qualifiedForEjection(task)).toBe(false);
    project.ruleSnapshots![0].rules.requiredCopies = 2;
    expect(ejectCopyRequirement(task, project)).toBeUndefined();
    project.ruleSnapshots!.push(project.ruleSnapshots![0]);
    expect(ejectCopyRequirement(task, project)).toBeUndefined();
  });
  it("does not let an ordinary one-copy task erase a failed two-copy project requirement", () => {
    const { task } = fixture(1); delete task.projectId; delete task.projectRuleSnapshotId;
    expect(qualifiedForEjection(task)).toBe(true);
    expect(qualifiedForEjection(task, undefined, 2)).toBe(false);
    task.status = "failed"; expect(qualifiedForEjection(task)).toBe(false);
  });
});
