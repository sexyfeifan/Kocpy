import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveResultDigest,
  archiveTaskBaselineDigest,
  emptyArchiveEvidence,
  recordArchiveNotifications,
  recordProjectArchiveRun,
  updateArchiveEvidence,
  validateArchiveEvidence,
} from "../src/main/archive-evidence";
import { repairArchiveFile } from "../src/main/archive-repair";
import { verifyArchiveTask } from "../src/main/archive-verification";
import { volumeIdentity } from "../src/main/system";
import type {
  ArchiveReminder,
  ArchiveVerificationRun,
  BackupTask,
} from "../src/main/types";

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "kocpy-packaged-archive-"),
  );
  try {
  const destinationRoot = path.join(root, "archive", "A001"),
    filePath = path.join(destinationRoot, "DCIM", "A001.mov"),
    bytes = Buffer.alloc(64 * 1024, 41),
    checksum = createHash("sha256").update(bytes).digest("hex");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  const identity = await volumeIdentity(destinationRoot),
    task: BackupTask = {
      id: "packaged-archive-task",
      projectId: "packaged-project",
      name: "A001",
      sourcePath: path.join(root, "offline-source"),
      devices: ["A Cam"],
      destinations: [
        {
          id: "archive-destination",
          path: destinationRoot,
          resolvedPath: destinationRoot,
          label: "ARCHIVE",
          verified: true,
          bytesWritten: bytes.length,
          volumeId: identity.id,
          volumeUuid: identity.uuid,
        },
      ],
      hashAlgorithm: "sha256",
      namingTemplate: "{name}",
      status: "completed",
      totalFiles: 1,
      completedFiles: 1,
      totalBytes: bytes.length,
      transferredBytes: bytes.length,
      speedBps: 0,
      eta: 0,
      currentFile: "",
      verifyLog: [],
      fileRecords: [
        {
          name: "A001.mov",
          relativePath: "DCIM/A001.mov",
          size: bytes.length,
          srcChecksum: checksum,
          destinations: [{ path: filePath, checksum, verified: true }],
        },
      ],
      createdAt: 1,
    },
    context = {
      runId: randomUUID(),
      operator: "packaged-runtime",
      projectId: "packaged-project",
    },
    healthy = await verifyArchiveTask(
      task,
      { kind: "project", projectId: task.projectId! },
      context,
    );
  assert.equal(healthy.result.status, "healthy");
  assert.equal(healthy.result.verifiedCopies, 1);
  assert.equal(task.fileRecords[0].destinations[0].verified, true);

  await fs.writeFile(filePath, Buffer.alloc(bytes.length, 42));
  const changed = await verifyArchiveTask(
    task,
    { kind: "project", projectId: task.projectId! },
    { ...context, runId: randomUUID() },
  );
  assert.equal(changed.result.status, "attention");
  assert.equal(changed.result.damagedFiles, 1);

  const sourcePath = path.join(root, "healthy-source.mov");
  await fs.writeFile(sourcePath, bytes);
  let preserved = "";
  const repaired = await repairArchiveFile({
    sourcePath,
    targetPath: filePath,
    expectedChecksum: checksum,
    hashAlgorithm: "sha256",
    onPreserved: (value) => {
      preserved = value;
    },
  });
  assert.equal(repaired.publishedChecksum, checksum);
  assert.ok(preserved);
  assert.equal((await fs.stat(preserved)).size, bytes.length);

  await fs.writeFile(filePath, "damaged again");
  await assert.rejects(
    repairArchiveFile({
      sourcePath,
      targetPath: filePath,
      expectedChecksum: checksum,
      hashAlgorithm: "sha256",
      failAt: "after-preserve",
    }),
    /注入故障/,
  );
  const survivors = await fs.readdir(path.dirname(filePath));
  assert.ok(survivors.some((name) => name.includes("kocpy-damaged")));
  assert.equal(survivors.some((name) => name.includes(".partial")), false);

  const taskResult = healthy.result,
    taskResults = [taskResult],
    run: ArchiveVerificationRun = {
      id: context.runId,
      projectId: context.projectId,
      scope: "project",
      scopeLabel: "packaged-project",
      operator: context.operator,
      startedAt: 10,
      completedAt: 20,
      status: "completed",
      taskResults,
      baselineDigest: archiveTaskBaselineDigest("packaged-project"),
      resultDigest: archiveResultDigest(taskResults),
      notes: [],
    },
    reminder: ArchiveReminder = {
      id: "packaged-reminder",
      projectId: context.projectId,
      intervalDays: 180,
      nextAt: 1,
      enabled: true,
    },
    notified = recordArchiveNotifications([reminder], [reminder.id], 5),
    completedReminders = recordProjectArchiveRun(notified, run, "healthy"),
    evidence = updateArchiveEvidence(emptyArchiveEvidence(1), {
      reminders: completedReminders,
      runs: [run],
      changes: healthy.changes,
    }, 20);
  validateArchiveEvidence(evidence);
  assert.equal(notified[0].nextAt, 1);
  assert.equal(completedReminders[0].lastSuccessfulVerificationAt, 20);
  const tampered = structuredClone(evidence);
  tampered.changes[0].note = "tampered";
  assert.throws(() => validateArchiveEvidence(tampered));

  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      architecture: process.arch,
      verifiedBytes: healthy.result.bytesVerified,
      evidenceDigest: evidence.digest,
      preservedOriginal: true,
    })}\n`,
  );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
