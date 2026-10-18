import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { completedBackupCoversAttempt } from "../src/common/source-scan";

function fixture(sourcePath = "/synthetic/card", createdAt = 1) {
  const task = new BackupEngine().createTask({
    name: "Synthetic ejection scope",
    sourcePath,
    destinationPaths: ["/synthetic/backup"],
    hashAlgorithm: "sha256",
    namingTemplate: "synthetic",
    devices: [],
    shootingDate: "",
  });
  task.status = "completed";
  task.createdAt = createdAt;
  task.sourceVolumeUuid = "synthetic-volume";
  task.inventoryScope = {
    policy: task.inventoryPolicy!, capturedAt: 1, sourcePath,
    fingerprint: "a".repeat(64), includedFiles: 0, includedBytes: 0,
    includedDirectories: 0, includedDirectoryPaths: [],
    excludedFiles: 0, excludedDirectories: 0, excludedBytes: 0, exclusions: [],
  };
  return task;
}

function omittedSource() {
  const task = fixture();
  task.inventoryScope!.excludedDirectories = 1;
  task.inventoryScope!.exclusions = [{
    relativePath: "restricted", kind: "directory", bytes: 0, modifiedAt: 1,
    reason: "permission-denied", bytesUnknown: true, permissionCode: "EACCES",
  }];
  return task;
}

describe("completed-volume ejection source coverage", () => {
  it("does not erase whole-card permission omissions with a later same-volume subfolder backup", () => {
    expect(completedBackupCoversAttempt(fixture("/synthetic/card/DCIM", 2), omittedSource())).toBe(false);
  });
  it("does not turn an unreadable historical scope into proven coverage retrospectively", () => {
    const attempt = omittedSource(), completed = fixture("/synthetic/card-alias", 2);
    completed.inventoryScope!.sourcePath = attempt.inventoryScope!.sourcePath;
    expect(completedBackupCoversAttempt(completed, attempt)).toBe(false);
  });
  it("does not erase a newer omission with an older successful scan or another partial scan", () => {
    const attempt = omittedSource();
    attempt.createdAt = 3;
    expect(completedBackupCoversAttempt(fixture("/synthetic/card", 2), attempt)).toBe(false);
    const partial = omittedSource();
    partial.createdAt = 4;
    expect(completedBackupCoversAttempt(partial, attempt)).toBe(false);
  });
  it("does not erase a legacy unscoped whole-card failure with a same-volume subfolder", () => {
    const attempt = fixture();
    attempt.status = "failed";
    delete attempt.inventoryScope;
    expect(completedBackupCoversAttempt(fixture("/synthetic/card/DCIM", 2), attempt)).toBe(false);
  });
  it("requires matching frozen roots, fingerprints, identities and known file hashes", () => {
    const attempt = fixture(), completed = fixture("/synthetic/card", 2);
    attempt.status = "failed";
    expect(completedBackupCoversAttempt(completed, attempt)).toBe(true);
    expect(completedBackupCoversAttempt(fixture("/synthetic/card/DCIM", 2), attempt)).toBe(false);
    completed.inventoryScope!.fingerprint = "b".repeat(64);
    expect(completedBackupCoversAttempt(completed, attempt)).toBe(false);
    completed.inventoryScope!.fingerprint = attempt.inventoryScope!.fingerprint;
    completed.sourceVolumeUuid = "replaced-card";
    expect(completedBackupCoversAttempt(completed, attempt)).toBe(false);
  });
  it("does not clear permission risk through a later filtered or unscoped scan", () => {
    const attempt = omittedSource(), completed = fixture("/synthetic/card", 2);
    completed.inventoryPolicy!.mode = "filtered";
    completed.inventoryPolicy!.includeHidden = false;
    expect(completedBackupCoversAttempt(completed, attempt)).toBe(false);
    delete completed.inventoryScope;
    delete completed.inventoryPolicy;
    expect(completedBackupCoversAttempt(completed, attempt)).toBe(false);
  });
});
