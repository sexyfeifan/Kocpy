import type { BackupTask } from "../main/types";

/** OS-owned volume directories; ordinary hidden material remains in scope. */
export const SYSTEM_SOURCE_DIRECTORIES = new Set([
  ".Spotlight-V100",
  ".Trashes",
  ".fseventsd",
  ".TemporaryItems",
  ".DocumentRevisions-V100",
  ".PKInstallSandboxManager",
  ".PKInstallSandboxManager-SystemSoftware",
]);

/** A same-volume subset must not erase evidence that the source was unreadable. */
export function completedBackupCoversAttempt(
  completed: BackupTask,
  attempt: BackupTask,
): boolean {
  if ((completed.createdAt || 0) < (attempt.createdAt || 0)) return false;
  if (completed.inventoryScope?.exclusions.some(
    (item) => item.reason === "permission-denied",
  )) return false;
  if (attempt.inventoryScope?.exclusions.some(
    (item) => item.reason === "permission-denied",
  )) {
    if (!completed.inventoryScope || completed.inventoryPolicy?.mode !== "complete")
      return false;
    if (completed.inventoryScope.sourcePath !== attempt.inventoryScope.sourcePath)
      return false;
  }
  return Boolean(
    (completed.sourceVolumeUuid && completed.sourceVolumeUuid === attempt.sourceVolumeUuid) ||
    completed.sourcePath === attempt.sourcePath,
  );
}
