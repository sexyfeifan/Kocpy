import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BackupTask, InventoryScopeSnapshot } from "../src/main/types";
import { TransferEvidence } from "../src/renderer/src/TransferEvidence";
import { destinationTransferEvidence, observedProgress, transferEvidenceModel } from "../src/renderer/src/transfer-evidence-state";

function fixture(overrides: Partial<BackupTask> = {}): BackupTask {
  return {
    id: "generated-task", name: "Generated", sourcePath: "/synthetic/source",
    devices: ["A"], destinations: [
      { id: "one", label: "ONE", path: "/synthetic/one", bytesWritten: 20, copiedBytes: 20, verifiedBytes: 0, copyProgress: 20, verifyProgress: 0, verified: false },
      { id: "two", label: "TWO", path: "/synthetic/two", bytesWritten: 70, copiedBytes: 70, verifiedBytes: 0, copyProgress: 70, verifyProgress: 0, verified: false },
    ], hashAlgorithm: "sha256", namingTemplate: "Generated", status: "running",
    transferPhase: "copying", totalFiles: 10, completedFiles: 2, totalBytes: 100,
    transferredBytes: 20, copyProgress: 20, verifyProgress: 0, speedBps: 5,
    eta: 10, currentFile: "generated.mov", verifyLog: [], fileRecords: [],
    ...overrides,
  };
}

function verifiedTask(): BackupTask {
  const task = fixture({ status: "completed", completedFiles: 10, transferredBytes: 100, copyProgress: 100, verifyProgress: 100 });
  task.destinations.forEach((destination, index) => {
    destination.verified = true;
    destination.copiedBytes = 100;
    destination.verifiedBytes = 100;
    destination.copyProgress = 100;
    destination.verifyProgress = 100;
    destination.volumeUuid = `GENERATED-${index}`;
  });
  return task;
}

function independentTargets(task: BackupTask) {
  task.destinations.forEach((destination, index) => {
    destination.storageEvidence = { assessmentId: "generated-snapshot", checkedAt: 1, kind: "local-physical", domains: [`disk${index + 1}`], reason: "generated", volumeUuid: destination.volumeUuid };
  });
}

describe("production transfer evidence", () => {
  it("uses actual target observations and leaves missing telemetry unknown", () => {
    const task = fixture();
    const model = transferEvidenceModel(task);
    expect(model.targets.map((target) => target.copyText)).toEqual(["20%", "70%"]);
    const missing = { ...task.destinations[1], copyProgress: undefined, copiedBytes: undefined, verifyProgress: undefined, verifiedBytes: undefined };
    const target = destinationTransferEvidence(task, missing);
    expect(target.copyProgress).toBeUndefined();
    expect(target.copyText).toBe("待更新");
    expect(target.savedText).toBe("已复制 待更新");
    expect(target.verifyText).toBe("待更新");
    expect(model.facts.find((fact) => fact.key === "copy")?.value).toBe("全任务 20%");
    expect(model.facts.find((fact) => fact.key === "verify")?.value).toBe("待完整校验");
  });

  it("never rounds an unfinished target to 100% or uses stale stopped speed", () => {
    const task = fixture({ status: "paused" });
    const target = destinationTransferEvidence(task, { ...task.destinations[0], copyProgress: 99.999, speedBps: 1024 });
    expect(target.copyText).toBe("99.9%");
    expect(target.speedText).toBeUndefined();
    expect(observedProgress(Number.NaN)).toBeUndefined();
    expect(observedProgress(-1)).toBeUndefined();
    expect(observedProgress(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("separates copy completion from the active readback stage", () => {
    const task = fixture({ status: "verifying", verifyProgress: 30 });
    task.destinations.forEach((destination) => { destination.copiedBytes = 100; destination.copyProgress = 100; });
    const model = transferEvidenceModel(task);
    expect(model.phases.find((phase) => phase.key === "copy")?.state).toBe("complete");
    expect(model.phases.find((phase) => phase.key === "verify")?.state).toBe("active");
    expect(model.phases.find((phase) => phase.key === "record")?.state).toBe("waiting");
    expect(model.facts.find((fact) => fact.key === "verify")?.state).toBe("active");
  });

  it("does not count multiple verified paths as physical independence", () => {
    const task = verifiedTask();
    const model = transferEvidenceModel(task);
    const independence = model.facts.find((fact) => fact.key === "independence")!;
    expect(independence.state).toBe("attention");
    expect(independence.value).toBe("2 个目标存储关系待核对");
    expect(independence.detail).toContain("当前任务可计 1 份");
    independentTargets(task);
    expect(transferEvidenceModel(task).facts.find((fact) => fact.key === "independence")).toMatchObject({ state: "complete", value: "2 个目标存储域独立" });
    task.destinations[1].storageEvidence!.domains = ["disk1"];
    expect(transferEvidenceModel(task).facts.find((fact) => fact.key === "independence")).toMatchObject({ state: "attention", value: "2 个目标存在共享存储域" });
  });

  it("retains scope verification while displaying the permission omission limit", () => {
    const task = verifiedTask();
    task.inventoryScope = {
      includedFiles: 10, includedBytes: 100,
      exclusions: [{ relativePath: "restricted", kind: "directory", bytes: 0, bytesUnknown: true, reason: "permission-denied", permissionCode: "EACCES" }],
    } as InventoryScopeSnapshot;
    const model = transferEvidenceModel(task);
    expect(model.permissionCount).toBe(1);
    expect(model.phases.find((phase) => phase.key === "scan")?.state).toBe("attention");
    expect(model.phases.find((phase) => phase.key === "verify")?.state).toBe("complete");
    expect(model.phases.find((phase) => phase.key === "record")?.state).toBe("attention");
    const markup = renderToStaticMarkup(<TransferEvidence task={task} />);
    expect(markup).toContain("范围内校验不证明源范围完整，不计整卡达标副本");
  });

  it("does not let old target verification claim a failed current task passed", () => {
    const task = fixture({ status: "failed", copyProgress: 20, errorMessage: "generated failure" });
    task.destinations[0].verified = true;
    const model = transferEvidenceModel(task);
    expect(model.facts.find((fact) => fact.key === "copy")?.state).toBe("attention");
    expect(model.facts.find((fact) => fact.key === "verify")).toMatchObject({ state: "attention", value: "本次未完整通过" });
    expect(model.phases.find((phase) => phase.key === "verify")?.state).toBe("attention");
    expect(renderToStaticMarkup(<TransferEvidence task={task} compact />)).toContain("generated failure");
  });

  it("retains failed-task historical topology without claiming countable copies", () => {
    const task = verifiedTask();
    independentTargets(task);
    task.status = "failed";
    const independence = transferEvidenceModel(task).facts.find((fact) => fact.key === "independence")!;
    expect(independence.state).toBe("attention");
    expect(independence.value).toBe("历史存储关系记录");
    expect(independence.detail).toContain("2 个目标存储域独立");
    expect(independence.detail).toContain("当前任务可计 0 份");
    expect(independence.detail).toContain("待本次完整校验");
  });

  it("requires current readback before reusing historical independent-target evidence", () => {
    const task = verifiedTask();
    independentTargets(task);
    task.status = "verifying";
    const independence = transferEvidenceModel(task).facts.find((fact) => fact.key === "independence")!;
    expect(independence.state).toBe("attention");
    expect(independence.value).toBe("历史存储关系记录");
    expect(independence.detail).toContain("当前任务可计 0 份");
    expect(independence.detail).toContain("待本次完整校验");
  });

  it("keeps independent topology separate from permission-limited source completeness", () => {
    const task = verifiedTask();
    independentTargets(task);
    task.inventoryScope = {
      includedFiles: 10, includedBytes: 100,
      exclusions: [{ relativePath: "restricted", kind: "directory", bytes: 0, bytesUnknown: true, reason: "permission-denied", permissionCode: "EACCES" }],
    } as InventoryScopeSnapshot;
    const independence = transferEvidenceModel(task).facts.find((fact) => fact.key === "independence")!;
    expect(independence.state).toBe("attention");
    expect(independence.value).toBe("2 个目标存储域独立");
    expect(independence.detail).toContain("当前任务可计 0 份");
    expect(independence.detail).toContain("完整源范围未确认");
  });

  it("labels adoption as existing content instead of a new copy", () => {
    const task = verifiedTask();
    task.provenance = "external-baseline";
    task.confidence = "baseline";
    const model = transferEvidenceModel(task);
    expect(model.facts.find((fact) => fact.key === "copy")?.value).toBe("已有副本接管");
    expect(model.targets[0].copyProgress).toBeUndefined();
    expect(model.targets[0].copyText).toBe("已有副本");
    expect(model.phases.find((phase) => phase.key === "copy")?.detail).toBe("本次接管未执行复制");
    expect(model.facts.find((fact) => fact.key === "verify")?.detail).toBe("接管时首次哈希基线");
    expect(model.phases.find((phase) => phase.key === "scan")).toMatchObject({ state: "waiting", detail: "识别接管范围 · 未保存冻结快照" });
  });

  it("keeps automatic report failure separate from successful content evidence", () => {
    const task = verifiedTask();
    task.automaticReport = { schema: 1, enabled: true, requestedAt: 1, operationAttemptId: "generated", status: "failed", attempts: 1, targets: [], error: "generated report error" };
    const model = transferEvidenceModel(task);
    expect(model.facts.find((fact) => fact.key === "verify")?.state).toBe("complete");
    expect(model.phases.find((phase) => phase.key === "record")).toMatchObject({ state: "attention", detail: "校验记录已保留 · 自动报告生成失败" });
  });
});
