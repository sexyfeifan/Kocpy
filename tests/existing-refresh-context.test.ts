import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendProjectRuleSnapshot, attachTaskEvidence } from "../src/main/project-evidence";
import { importExistingBackup, previewExistingBackup } from "../src/main/production-lifecycle";
import { existingRefreshContext, existingRefreshMetadataNote, existingRefreshObservation } from "../src/main/existing-refresh-context";
import type { BackupTask, ProjectConfig } from "../src/main/types";

let root: string, card: string, original: ProjectConfig, changed: ProjectConfig, task: BackupTask;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-refresh-rules-")));
  card = path.join(root, "OriginalProject", "FX3", "20261015", "CARD001");
  await fs.mkdir(card, { recursive: true });
  await fs.writeFile(path.join(card, "clip.mov"), "generated media fixture");
  await fs.writeFile(path.join(card, "original.mhl"), "<hashlist></hashlist>");
  original = appendProjectRuleSnapshot(undefined, {
    id: "generated-refresh-project", name: "OriginalProject", projectFolderName: "OriginalProject",
    devices: ["FX3"], devicePositions: { FX3: ["A", "B"] }, volumePrefix: "A",
    shootingDateStart: "2026-10-15", shootingDateEnd: "2026-10-16",
    namingRule: "{project}/{device}/{shootingDate}/{card}", requiredCopies: 1,
  }, { at: 1, operator: "Fixture A" });
  task = attachTaskEvidence(await importExistingBackup(original, card, "external-baseline", {
    shootingDate: "2026-10-15", device: "FX3", card: "CARD001",
  }), original);
  changed = appendProjectRuleSnapshot(original, {
    ...original, name: "RenamedProject", projectFolderName: "RenamedProject", devices: ["POCKET"],
    devicePositions: { POCKET: ["C"] }, namingRule: "{project}/{shootingDate}/{device}/{card}",
    shootingDateStart: "2026-11-01", shootingDateEnd: "2026-11-02",
  }, { at: 2, operator: "Fixture B" });
});
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

describe("existing backup refresh respects frozen mapping authority", () => {
  it("reproduces A-to-B reinterpretation and uses only the task's original rule snapshot", async () => {
    const beforeTask = structuredClone(task), beforeProject = structuredClone(changed);
    const wronglyCurrent = await previewExistingBackup(card, changed, "card", task.shootingDate);
    expect(wronglyCurrent.candidates[0].device).toBe("CARD001");
    const context = existingRefreshContext(task, changed);
    expect(context.ruleStatus).toBe("frozen-snapshot");
    expect(context.project).toMatchObject({ name: "OriginalProject", devices: ["FX3"],
      namingRule: original.namingRule, shootingDateStart: original.shootingDateStart,
      activeRuleSnapshotId: original.activeRuleSnapshotId });
    const correct = await previewExistingBackup(card, context.project, "card", task.shootingDate);
    expect(correct.candidates[0].device).toBe("FX3");
    expect(existingRefreshObservation(task, correct).metadata).toEqual({ shootingDate: "2026-10-15", devices: ["FX3"], cameraPosition: undefined, name: "CARD001" });
    expect(task).toEqual(beforeTask);
    expect(changed).toEqual(beforeProject);
  });

  it("preserves an explicit operator mapping even when the frozen directory interpretation differs", async () => {
    task.devices = ["Operator camera alias", "Second recorded device"];
    task.cameraPosition = "B";
    task.name = "Operator roll name";
    task.shootingDate = "2026-10-14";
    const before = structuredClone(task), context = existingRefreshContext(task, changed);
    const preview = await previewExistingBackup(card, context.project, "card", task.shootingDate);
    expect(preview.candidates[0].device).toBe("FX3");
    expect(preview.candidates[0].shootingDate).toBe("2026-10-15");
    const result = existingRefreshObservation(task, preview);
    expect(result.metadata).toEqual({ shootingDate: "2026-10-14", devices: ["Operator camera alias", "Second recorded device"], cameraPosition: "B", name: "Operator roll name" });
    expect(result.metadataPreserved).toBe(true);
    expect(task).toEqual(before);
  });

  it("keeps legacy saved metadata without using today's project rules as a substitute", async () => {
    task.projectRuleSnapshotId = undefined;
    const before = structuredClone(task), context = existingRefreshContext(task, changed);
    expect(context).toMatchObject({ project: undefined, ruleStatus: "legacy-without-snapshot" });
    const preview = await previewExistingBackup(card, context.project, "card", task.shootingDate);
    expect(preview.candidates[0].device).toBeUndefined();
    expect(existingRefreshObservation(task, preview).metadata.devices).toEqual(["FX3"]);
    expect(task).toEqual(before);
  });

  it("does not fill missing or deliberately unknown metadata from inferred folder names", async () => {
    task.projectRuleSnapshotId = undefined; task.devices = []; task.shootingDate = ""; task.name = ""; task.cameraPosition = undefined;
    const before = structuredClone(task), context = existingRefreshContext(task, changed);
    const preview = await previewExistingBackup(card, context.project, "card", task.shootingDate);
    expect(preview.candidates[0].shootingDate).toBe("2026-10-15");
    expect(existingRefreshObservation(task, preview).metadata).toEqual({ shootingDate: "", devices: [], cameraPosition: undefined, name: "" });
    expect(task).toEqual(before);
  });

  it("observes changed raw counts without changing verified records, paths, report evidence or original MHL", async () => {
    const before = structuredClone(task), manifest = await fs.readFile(path.join(card, "original.mhl"));
    const context = existingRefreshContext(task, changed);
    const first = existingRefreshObservation(task, await previewExistingBackup(card, context.project, "card", task.shootingDate));
    await fs.writeFile(path.join(card, "new-unverified.mov"), "new observation only");
    const second = existingRefreshObservation(task, await previewExistingBackup(card, context.project, "card", task.shootingDate));
    expect(second.observedInventory.files).toBe(first.observedInventory.files + 1);
    expect(second.observedInventory.bytes).toBe(first.observedInventory.bytes + Buffer.byteLength("new observation only"));
    expect(second.metadata).toEqual(first.metadata);
    expect(task.totalFiles).toBe(1);
    expect(task).toEqual(before);
    expect(await fs.readFile(path.join(card, "original.mhl"))).toEqual(manifest);
    expect(await fs.readFile(path.join(card, "clip.mov"), "utf8")).toBe("generated media fixture");
  });

  it("does not reuse previews for the same root under different snapshots or selected dates", () => {
    const old = existingRefreshContext(task, changed);
    const current = existingRefreshContext({ ...task, projectRuleSnapshotId: changed.activeRuleSnapshotId }, changed);
    const dateChanged = existingRefreshContext({ ...task, shootingDate: "2026-10-16" }, changed);
    expect(old.cacheKey).not.toBe(current.cacheKey);
    expect(old.cacheKey).not.toBe(dateChanged.cacheKey);
    expect(existingRefreshContext(structuredClone(task), structuredClone(changed)).cacheKey).toBe(old.cacheKey);
  });

  it("refuses missing, tampered, duplicate or wrong-project snapshot interpretation without guessing", () => {
    const badHash = structuredClone(changed);
    badHash.ruleSnapshots![0].rules.namingRule = changed.namingRule!;
    const duplicate = structuredClone(changed);
    duplicate.ruleSnapshots!.push(structuredClone(duplicate.ruleSnapshots![0]));
    for (const project of [badHash, duplicate, { ...changed, ruleSnapshots: [] }, { ...changed, id: "another-project" }]) {
      expect(existingRefreshContext(task, project)).toMatchObject({ project: undefined, ruleStatus: "snapshot-unavailable" });
    }
  });

  it("returns a detached project view and explains the metadata and verification boundary", () => {
    const before = structuredClone(changed), context = existingRefreshContext(task, changed);
    context.project!.devices.push("Mutation of preview only");
    context.project!.devicePositions!.FX3.push("Preview only");
    expect(changed).toEqual(before);
    expect(existingRefreshMetadataNote).toContain("显式核对并确认映射");
    expect(existingRefreshMetadataNote).toContain("不替代原校验基线");
  });
});
