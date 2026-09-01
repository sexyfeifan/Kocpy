// Bundle with esbuild, then execute using each packaged Electron runtime in Node mode.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginCompletionAction,
  ensureCompletionActionPlan,
  failCompletionAction,
  finishCompletionAction,
  publishNewArtifact,
  recoverInterruptedCompletionActions,
  validateCompletionActionRecords,
} from "../src/main/completion-automation";
import type { BackupTask, ProjectConfig } from "../src/main/types";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-packaged-automation-"));
  try {
    const task: BackupTask = {
        id: "packaged-automation-task",
        name: "A001",
        projectId: "packaged-project",
        projectRuleSnapshotId: "rules-1",
        sourcePath: path.join(root, "offline-source"),
        devices: ["A Cam"],
        destinations: [],
        hashAlgorithm: "sha256",
        namingTemplate: "{card}",
        status: "completed",
        totalFiles: 0,
        completedFiles: 0,
        totalBytes: 0,
        transferredBytes: 0,
        speedBps: 0,
        eta: 0,
        currentFile: "",
        verifyLog: [],
        fileRecords: [],
      },
      project: ProjectConfig = {
        id: "packaged-project",
        name: "Packaged automation",
        devices: ["A Cam"],
        volumePrefix: "A_",
        completionActions: ["eject"],
        activeRuleSnapshotId: "rules-2",
        ruleSnapshots: [
          {
            id: "rules-1",
            revision: 1,
            createdAt: 1,
            operator: "packaged-runtime",
            reason: "project-created",
            sha256: "frozen",
            rules: {
              projectFolderName: "Packaged automation",
              shootingDateStart: "2026-09-02",
              shootingDateEnd: "2026-09-02",
              devices: ["A Cam"],
              volumePrefix: "A_",
              volumePrefixByDevice: {},
              devicePositions: {},
              destinationPaths: [path.join(root, "backup")],
              requiredCopies: 2,
              namingRule: "{card}",
              completionActions: ["report", "proxy"],
              checklists: [],
            },
          },
        ],
      };

    assert.equal(ensureCompletionActionPlan(task, project, 10), true);
    assert.deepEqual(
      task.completionActionRecords?.map((record) => record.action),
      ["report", "proxy"],
    );
    assert.equal(ensureCompletionActionPlan(task, project, 20), false);

    const report = beginCompletionAction(task, "report", "packaged-runtime", 30);
    assert.equal(report.shouldRun, true);
    const target = path.join(root, "report.json"),
      value = JSON.stringify({ taskId: task.id, evidence: "synthetic" }),
      published = await publishNewArtifact(target, value);
    finishCompletionAction(report.record, {
      result: "synthetic report written",
      outputPaths: [target],
      outputSha256: { [target]: published.sha256 },
      at: 40,
    });
    assert.equal(beginCompletionAction(task, "report", "packaged-runtime", 50).shouldRun, false);
    await assert.rejects(publishNewArtifact(target, "replacement"), /未覆盖/);
    assert.equal(await fs.readFile(target, "utf8"), value);

    const proxy = beginCompletionAction(task, "proxy", "packaged-runtime", 60);
    failCompletionAction(proxy.record, new Error("synthetic source offline"), 70);
    assert.equal(proxy.record.status, "failed");
    beginCompletionAction(task, "proxy", "packaged-runtime", 80);
    assert.equal(recoverInterruptedCompletionActions(task, 90), true);
    assert.match(proxy.record.error || "", /中断/);
    validateCompletionActionRecords(task);

    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        architecture: process.arch,
        actions: task.completionActionRecords?.length,
        reportSha256: published.sha256,
        existingArtifactPreserved: true,
        interruptedActionFailedClosed: true,
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
