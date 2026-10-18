import type { BackupTask } from "../main/types";
import { taskHasPartialSelection } from "./task-trust";

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

/** Coverage needs the same recorded scope, not merely the same disk or folder label.
 * Missing legacy scope and unreadable content cannot be retrospectively proven. */
export function completedBackupCoversAttempt(
  completed: BackupTask,
  attempt: BackupTask,
): boolean {
  if (completed.status !== "completed" || taskHasPartialSelection(completed)) return false;
  if ((completed.createdAt || 0) < (attempt.createdAt || 0)) return false;
  if (completed.inventoryScope?.exclusions.some(
    (item) => item.reason === "permission-denied",
  )) return false;
  const full = completed.inventoryScope, prior = attempt.inventoryScope;
  if (!full || !prior || full.policy.version !== "complete-v2" ||
    full.policy.mode !== "complete" || completed.inventoryPolicy?.mode !== "complete" ||
    full.sourcePath !== prior.sourcePath || full.fingerprint !== prior.fingerprint ||
    full.includedFiles !== prior.includedFiles || full.includedBytes !== prior.includedBytes ||
    attempt.inventoryScope?.exclusions.some(item => item.reason === "permission-denied") ||
    completed.fileRecords.length !== full.includedFiles) return false;
  const sameIdentity = completed.sourceVolumeUuid || attempt.sourceVolumeUuid
    ? Boolean(completed.sourceVolumeUuid && completed.sourceVolumeUuid === attempt.sourceVolumeUuid)
    : Boolean(completed.sourceVolumeId && completed.sourceVolumeId === attempt.sourceVolumeId);
  if (!sameIdentity) return false;
  const records = new Map(completed.fileRecords.map(file => [file.relativePath, file]));
  return attempt.fileRecords.every(file => {
    const replacement = records.get(file.relativePath);
    return replacement && replacement.size === file.size && (!file.srcChecksum ||
      completed.hashAlgorithm === attempt.hashAlgorithm && replacement.srcChecksum === file.srcChecksum);
  });
}
