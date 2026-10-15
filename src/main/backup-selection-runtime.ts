import type { Destination } from "./types";
import type { BackupSelectionDependencies } from "./backup-selection";
import { volumeIdentity } from "./system";
import { refreshStorageEvidence } from "./storage-topology";
import { probeMediaCreationTime } from "./media";

/** One fresh physical-topology observation; never combine old disk node names. */
export async function assessSelectionStorage(paths: string[]) {
  const copies: Destination[] = await Promise.all(paths.map(async (location, index) => {
    const identity = await volumeIdentity(location);
    return { id: String(index), path: location, resolvedPath: location,
      label: location, verified: true, bytesWritten: 0,
      volumeId: identity.id, volumeUuid: identity.uuid };
  }));
  await refreshStorageEvidence(copies);
  return copies.map((copy) => copy.storageEvidence!);
}

export const selectionRuntimeDependencies = (
  extra: Partial<BackupSelectionDependencies> = {},
): BackupSelectionDependencies => ({
  identifyVolume: volumeIdentity,
  assessStorage: assessSelectionStorage,
  readEmbeddedDate: probeMediaCreationTime,
  ...extra,
});
