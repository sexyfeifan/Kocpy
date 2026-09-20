import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ArchiveScope } from "../common/interaction";
import type {
  ArchiveChangeRecord,
  ArchiveVerificationTaskResult,
  BackupTask,
} from "./types";
import { hashFile } from "./backup/BackupEngine";
import { inside } from "./backup/safety";
import { volumeIdentity } from "./system";
import { assertVolumeIdentity } from "../common/volume-identity";
import {
  archiveResultDigest,
  archiveTaskBaselineDigest,
} from "./archive-evidence";
import {
  inspectRecordedDirectoryScope,
  recordedInventoryBaseline,
} from "./inventory-baseline";

type Progress = (value: {
  message: string;
  currentFile?: string;
  completedBytes?: number;
}) => void;

const identityFailure = (message: string) =>
  /UUID|身份|不是原记录|已变化/.test(message);

export function taskArchiveBaseline(task: BackupTask) {
  return {
    taskId: task.id,
    logicalVolumeId: task.logicalVolumeId,
    hashAlgorithm: task.hashAlgorithm,
    totalFiles: task.totalFiles,
    totalBytes: task.totalBytes,
    inventoryPolicy: task.inventoryPolicy,
    inventoryScope: task.inventoryScope,
    destinations: task.destinations.map((destination) => ({
      id: destination.id,
      path: destination.resolvedPath || destination.path,
      volumeId: destination.volumeId,
      volumeUuid: destination.volumeUuid,
    })),
    files: task.fileRecords.map((record) => ({
      relativePath: record.relativePath,
      size: record.size,
      checksum: record.srcChecksum,
      destinations: record.destinations.map((copy) => copy.path),
    })),
  };
}

function topDestinationIndex(task: BackupTask, copyPath: string) {
  return task.destinations.findIndex((destination) =>
    inside(copyPath, destination.resolvedPath || destination.path),
  );
}

export async function verifyArchiveTask(
  input: BackupTask,
  scope: ArchiveScope,
  context: { runId: string; operator: string; projectId: string },
  progress?: Progress,
) {
  const task = structuredClone(input);
  recordedInventoryBaseline(task);
  const records = scope.relativePath
    ? task.fileRecords.filter(
        (record) => record.relativePath === scope.relativePath,
      )
    : task.fileRecords;
  if (scope.relativePath && !records.length)
    throw new Error(`${task.name} 不包含所选文件`);
  const selectedTop = new Set<number>();
  if (!scope.relativePath)
    for (const [index, destination] of task.destinations.entries()) {
      const root = destination.resolvedPath || destination.path;
      if (
        !scope.volumePath ||
        inside(root, scope.volumePath) ||
        inside(scope.volumePath, root)
      )
        selectedTop.add(index);
    }
  for (const record of records)
    for (const copy of record.destinations) {
      if (scope.volumePath && !inside(copy.path, scope.volumePath)) continue;
      const index = topDestinationIndex(task, copy.path);
      if (index >= 0) selectedTop.add(index);
    }
  if (!selectedTop.size)
    throw new Error(`${task.name} 在所选范围没有可校验的副本`);

  const topState = new Map<
      number,
      { status: "online" | "offline" | "identity-unknown"; error?: string }
    >(),
    changes: Array<Omit<ArchiveChangeRecord, "previousDigest" | "digest">> = [];
  for (const index of selectedTop) {
    const destination = task.destinations[index],
      location = destination.resolvedPath || destination.path;
    try {
      const identity = await volumeIdentity(location);
      assertVolumeIdentity(
        destination.volumeUuid,
        destination.volumeId,
        identity,
        `${destination.label} `,
      );
      destination.available = true;
      destination.error = undefined;
      topState.set(index, { status: "online" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error),
        status = identityFailure(message) ? "identity-unknown" : "offline";
      destination.available = false;
      destination.verified = false;
      destination.error = message;
      topState.set(index, { status, error: message });
      changes.push({
        id: randomUUID(),
        projectId: context.projectId,
        taskId: task.id,
        runId: context.runId,
        operator: context.operator,
        at: Date.now(),
        kind: "missing",
        path: location,
        targetVolumeId: destination.volumeUuid || destination.volumeId,
        outcome: "failed",
        note:
          status === "identity-unknown"
            ? `无法确认 ${destination.label} 的归档盘身份：${message}`
            : `${destination.label} 当前离线或不可读：${message}`,
      });
    }
  }

  let checkedCopies = 0,
    verifiedCopies = 0,
    missingFiles = 0,
    missingDirectories = 0,
    damagedFiles = 0,
    bytesVerified = 0;
  const issues: string[] = [],
    directoryFailures = new Set<number>();
  for (const record of records)
    for (const copy of record.destinations) {
      if (scope.volumePath && !inside(copy.path, scope.volumePath)) continue;
      const index = topDestinationIndex(task, copy.path);
      if (!selectedTop.has(index)) continue;
      const state = topState.get(index)!;
      if (state.status !== "online") {
        copy.verified = false;
        continue;
      }
      checkedCopies++;
      progress?.({
        message: `正在完整读取 ${task.name}`,
        currentFile: record.relativePath,
        completedBytes: bytesVerified,
      });
      const exists = await fs.access(copy.path).then(
        () => true,
        () => false,
      );
      if (!exists) {
        copy.verified = false;
        missingFiles++;
        const note = `${record.relativePath} 在 ${task.destinations[index].label} 缺失`;
        issues.push(note);
        changes.push({
          id: randomUUID(),
          projectId: context.projectId,
          taskId: task.id,
          runId: context.runId,
          operator: context.operator,
          at: Date.now(),
          kind: "missing",
          path: copy.path,
          relativePath: record.relativePath,
          hashAlgorithm: task.hashAlgorithm,
          expectedChecksum: record.srcChecksum,
          targetVolumeId:
            task.destinations[index].volumeUuid ||
            task.destinations[index].volumeId,
          outcome: "failed",
          note,
        });
        continue;
      }
      const actual = await hashFile(copy.path, task.hashAlgorithm),
        verified = actual === record.srcChecksum;
      copy.checksum = actual;
      copy.verified = verified;
      if (verified) {
        verifiedCopies++;
        bytesVerified += record.size;
      } else {
        damagedFiles++;
        const note = `${record.relativePath} 在 ${task.destinations[index].label} 的哈希与基线不同`;
        issues.push(note);
        changes.push({
          id: randomUUID(),
          projectId: context.projectId,
          taskId: task.id,
          runId: context.runId,
          operator: context.operator,
          at: Date.now(),
          kind: "modified",
          path: copy.path,
          relativePath: record.relativePath,
          hashAlgorithm: task.hashAlgorithm,
          expectedChecksum: record.srcChecksum,
          actualChecksum: actual,
          targetVolumeId:
            task.destinations[index].volumeUuid ||
            task.destinations[index].volumeId,
          outcome: "failed",
          note,
        });
      }
    }

  if (!scope.relativePath)
    for (const index of selectedTop) {
      if (topState.get(index)?.status !== "online") continue;
      const destination = task.destinations[index],
        root = destination.resolvedPath || destination.path,
        directoryResult = await inspectRecordedDirectoryScope(task, root);
      for (const issue of directoryResult.issues) {
        missingDirectories++;
        directoryFailures.add(index);
        const note = `${issue.relativePath} 在 ${destination.label} 的目录结构缺失或无效：${issue.message}`;
        issues.push(note);
        changes.push({
          id: randomUUID(),
          projectId: context.projectId,
          taskId: task.id,
          runId: context.runId,
          operator: context.operator,
          at: Date.now(),
          kind: "missing",
          path: root,
          relativePath:
            issue.relativePath === "." ? undefined : issue.relativePath,
          targetVolumeId: destination.volumeUuid || destination.volumeId,
          outcome: "failed",
          note,
        });
      }
    }

  for (const index of selectedTop) {
    const destination = task.destinations[index],
      root = destination.resolvedPath || destination.path;
    if (scope.relativePath) {
      if (
        records.some((record) =>
          record.destinations.some(
            (copy) => inside(copy.path, root) && !copy.verified,
          ),
        )
      )
        destination.verified = false;
    } else {
      destination.verified =
        topState.get(index)?.status === "online" &&
        !directoryFailures.has(index) &&
        task.fileRecords.every((record) =>
          record.destinations.some(
            (copy) => inside(copy.path, root) && copy.verified,
          ),
        );
    }
  }
  const offlineCopies = [...topState.values()].filter(
      (item) => item.status === "offline",
    ).length,
    identityUnknownCopies = [...topState.values()].filter(
      (item) => item.status === "identity-unknown",
    ).length,
    status: ArchiveVerificationTaskResult["status"] = identityUnknownCopies
      ? "identity-unknown"
      : offlineCopies
        ? "offline"
        : missingFiles ||
            missingDirectories ||
            damagedFiles ||
            verifiedCopies !== checkedCopies
          ? "attention"
          : "healthy";
  for (const value of topState.values()) if (value.error) issues.push(value.error);
  const resultBody = {
      taskId: task.id,
      taskName: task.name,
      baselineDigest: archiveTaskBaselineDigest(taskArchiveBaseline(input)),
      status,
      checkedCopies,
      verifiedCopies,
      missingFiles,
      missingDirectories,
      damagedFiles,
      offlineCopies,
      identityUnknownCopies,
      bytesVerified,
      issues,
    },
    result: ArchiveVerificationTaskResult = {
      ...resultBody,
      evidenceDigest: archiveResultDigest(resultBody),
    };
  const fullTaskScope = !scope.relativePath && !scope.volumePath;
  if (fullTaskScope) {
    task.status = status === "healthy" ? "completed" : "failed";
    task.errorMessage = status === "healthy" ? undefined : issues[0] || "归档复校验未通过";
    if (status === "healthy") task.lastVerifiedAt = Date.now();
  }
  changes.push({
    id: randomUUID(),
    projectId: context.projectId,
    taskId: task.id,
    runId: context.runId,
    operator: context.operator,
    at: Date.now(),
    kind: status === "healthy" ? "verified" : "damaged",
    hashAlgorithm: task.hashAlgorithm,
    expectedChecksum: result.baselineDigest,
    actualChecksum: result.evidenceDigest,
    outcome: status === "healthy" ? "completed" : "failed",
    note:
      status === "healthy"
        ? `${task.name} 归档复校验通过`
        : `${task.name} 归档复校验需处理：${issues.join("；") || status}`,
  });
  return { task, result, changes };
}
