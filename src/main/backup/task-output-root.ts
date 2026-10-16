import path from "node:path";
import type { BackupTask, Destination } from "../types";

const outputRootConflictMessage =
  "目标素材卷目录已被其他任务占用，请重新领取卷名并核对目的地路径后再开始";

/** Pure lexical key for create-time checks; never blocks on an offline disk. */
export function taskOutputRootKey(input: string): string {
  return path
    .resolve(input)
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
}

export function outputRootsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`)
  );
}

export function taskDestinationOutputRoot(
  task: Pick<
    BackupTask,
    "copyMode" | "mirrorLayout" | "namingTemplate" | "shootingDateFolder"
  >,
  destination: Pick<Destination, "path">,
  destinationRoot = destination.path,
): string {
  return task.copyMode === "mirror"
    ? task.mirrorLayout === "source-folder"
      ? path.join(destinationRoot, task.namingTemplate)
      : destinationRoot
    : path.join(
        destinationRoot,
        task.shootingDateFolder || "",
        task.namingTemplate,
      );
}

/**
 * Return every root that can name a task's material directory. resolvedPath is
 * authoritative after start; the frozen logical root protects pending and
 * offline records and detects stale aliases.
 */
export function taskOutputRoots(task: BackupTask): string[] {
  const roots: string[] = [];
  for (const destination of task.destinations) {
    if (destination.resolvedPath && path.isAbsolute(destination.resolvedPath))
      roots.push(destination.resolvedPath);
    if (!path.isAbsolute(destination.path)) continue;
    roots.push(taskDestinationOutputRoot(task, destination));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function assertOutputRootKeysAvailable(
  candidateKeys: string[],
  recordedKeys: string[],
): void {
  const accepted: string[] = [];
  for (const key of candidateKeys) {
    if (
      accepted.some((other) => outputRootsOverlap(key, other)) ||
      recordedKeys.some((other) => outputRootsOverlap(key, other))
    )
      throw new Error(outputRootConflictMessage);
    accepted.push(key);
  }
}

/**
 * New project tasks may never share or nest a final absolute media root with
 * another logical task, including another project or ordinary/mirror backup.
 * This phase is deliberately filesystem-free; runtime resolves only the new
 * task's at-most-four roots asynchronously before mkdir or media writes.
 */
export function assertTaskOutputRootsAvailable(
  candidate: BackupTask,
  recorded: BackupTask[],
): void {
  if (!candidate.projectId) return;
  const recordedKeys = recorded
      .filter((task) => task.id !== candidate.id)
      .flatMap(taskOutputRoots)
      .map(taskOutputRootKey),
    candidateKeys = taskOutputRoots(candidate).map(taskOutputRootKey);
  assertOutputRootKeysAvailable(candidateKeys, recordedKeys);
}
