import { createHash } from "node:crypto";
import path from "node:path";
import type { BackupTask, Destination, FileRecord } from "./types";

export function existingSourceKey(sourcePath: string): string {
  return path.resolve(sourcePath).normalize("NFC");
}

function structuralSignature(task: BackupTask): string {
  return JSON.stringify(
    task.fileRecords
      .map((record) => [record.relativePath, record.size])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

const manifestRecord = (relativePath: string) =>
  /(?:\.mhl|sha(?:1|256)sums\.txt|manifest.*\.json)$/i.test(
    path.basename(relativePath),
  );

function structuralFiles(task: BackupTask, prefix = "") {
  return new Map(
    task.fileRecords
      .filter((record) => !manifestRecord(record.relativePath))
      .map((record) => [
        path
          .normalize(path.join(prefix, record.relativePath))
          .normalize("NFC"),
        record.size,
      ]),
  );
}

function aggregateRecordIds(tasks: BackupTask[]) {
  const aggregates = new Set<string>();
  for (const parent of tasks) {
    const parentRoot = existingSourceKey(parent.sourcePath);
    const descendants = tasks.filter((candidate) => {
      if (candidate.id === parent.id) return false;
      const relative = path.relative(
        parentRoot,
        existingSourceKey(candidate.sourcePath),
      );
      return Boolean(
        relative &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative),
      );
    });
    if (!descendants.length) continue;
    const parentFiles = structuralFiles(parent),
      descendantFiles = new Map<string, number>();
    for (const descendant of descendants) {
      const prefix = path.relative(
        parentRoot,
        existingSourceKey(descendant.sourcePath),
      );
      for (const [relativePath, size] of structuralFiles(descendant, prefix))
        descendantFiles.set(relativePath, size);
    }
    if (
      parentFiles.size > 0 &&
      parentFiles.size === descendantFiles.size &&
      [...parentFiles].every(
        ([relativePath, size]) => descendantFiles.get(relativePath) === size,
      )
    )
      aggregates.add(parent.id);
  }
  return [...aggregates];
}

export function existingContentFingerprint(
  task: BackupTask,
): string | undefined {
  if (
    !task.fileRecords.length ||
    task.fileRecords.some((record) => !record.srcChecksum)
  )
    return undefined;
  return createHash("sha256")
    .update(
      JSON.stringify({
        shootingDate: task.shootingDate,
        files: task.fileRecords
          .map((record) => [
            record.relativePath,
            record.size,
            record.srcChecksum,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      }),
    )
    .digest("hex");
}

function importedAt(task: BackupTask): number {
  return task.importedAt || task.createdAt || task.completedAt || 0;
}

function trustScore(task: BackupTask): number {
  if (task.status !== "completed") return 0;
  if (task.confidence === "verified") return 3;
  if (task.confidence === "baseline") return 2;
  return 1;
}

function destinationKey(destination: Destination): string {
  return existingSourceKey(destination.resolvedPath || destination.path);
}

function copyDestination(target: FileRecord, source: FileRecord) {
  if (!target.srcChecksum && source.srcChecksum)
    target.srcChecksum = source.srcChecksum;
  for (const destination of source.destinations) {
    const key = existingSourceKey(destination.path);
    if (
      !target.destinations.some(
        (existing) => existingSourceKey(existing.path) === key,
      )
    )
      target.destinations.push(destination);
  }
}

function mergeGroup(group: BackupTask[]): {
  primary: BackupTask;
  duplicateIds: string[];
} {
  const structures = new Set(group.map(structuralSignature));
  const checksummedContents = new Set(
    group
      .map(existingContentFingerprint)
      .filter((value): value is string => Boolean(value)),
  );
  const recordsAgree = structures.size === 1 && checksummedContents.size <= 1;
  const ordered = [...group].sort((a, b) => {
    if (recordsAgree && trustScore(a) !== trustScore(b))
      return trustScore(b) - trustScore(a);
    return importedAt(b) - importedAt(a);
  });
  const primary = ordered[0];
  for (const duplicate of ordered.slice(1)) {
    for (const destination of duplicate.destinations) {
      const key = destinationKey(destination);
      if (
        !primary.destinations.some(
          (existing) => destinationKey(existing) === key,
        )
      )
        primary.destinations.push(destination);
    }
    if (recordsAgree)
      for (const record of duplicate.fileRecords) {
        const target = primary.fileRecords.find(
          (candidate) =>
            candidate.relativePath === record.relativePath &&
            candidate.size === record.size,
        );
        if (target) copyDestination(target, record);
      }
  }
  primary.verifyLog = [
    ...primary.verifyLog,
    `刷新接管信息时合并 ${ordered.length - 1} 条重复素材卷记录；未移动或重新读取素材文件`,
  ].slice(-120);
  return {
    primary,
    duplicateIds: ordered.slice(1).map((task) => task.id),
  };
}

export function consolidateExistingRecords(tasks: BackupTask[]): {
  records: BackupTask[];
  duplicateIds: string[];
  aggregateIds: string[];
} {
  let records = [...tasks];
  const duplicateIds: string[] = [];
  const consolidateGroups = (groups: BackupTask[][]) => {
    for (const group of groups.filter((items) => items.length > 1)) {
      const merged = mergeGroup(group);
      duplicateIds.push(...merged.duplicateIds);
      const removed = new Set(merged.duplicateIds);
      records = records.filter((task) => !removed.has(task.id));
    }
  };

  const sourceGroups = new Map<string, BackupTask[]>();
  for (const task of records) {
    const key = existingSourceKey(task.sourcePath);
    sourceGroups.set(key, [...(sourceGroups.get(key) || []), task]);
  }
  consolidateGroups([...sourceGroups.values()]);

  const contentGroups = new Map<string, BackupTask[]>();
  for (const task of records) {
    const fingerprint = existingContentFingerprint(task);
    if (!fingerprint) continue;
    contentGroups.set(fingerprint, [
      ...(contentGroups.get(fingerprint) || []),
      task,
    ]);
  }
  consolidateGroups([...contentGroups.values()]);
  const aggregateIds = aggregateRecordIds(records),
    aggregateSet = new Set(aggregateIds);
  records = records.filter((task) => !aggregateSet.has(task.id));
  return {
    records,
    duplicateIds: [...new Set(duplicateIds)],
    aggregateIds,
  };
}

export function deduplicateBoundRoots<
  T extends { id: string; path: string; boundAt: number; provenance: string },
>(roots: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const root of roots) {
    const key = existingSourceKey(root.path);
    const current = byPath.get(key);
    if (!current || root.boundAt > current.boundAt) byPath.set(key, root);
  }
  return [...byPath.values()].sort((a, b) => a.boundAt - b.boundAt);
}
