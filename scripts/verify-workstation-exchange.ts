// Bundle with esbuild, then execute using each packaged Electron runtime in Node mode.
// This uses only isolated synthetic metadata and never opens user projects or media.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyArchiveEvidence } from "../src/main/archive-evidence";
import { validateWorkspacePackage } from "../src/main/lifecycle";
import { Storage } from "../src/main/storage";
import type { BackupTask, ProjectConfig } from "../src/main/types";
import {
  applyWorkspaceMerge,
  buildWorkspaceImportPreview,
  commitWorkstationImportTransaction,
  createWorkspacePackage,
  loadOrCreateWorkstationIdentity,
} from "../src/main/workstation-exchange";
import { sealWorkspaceState } from "../src/main/workspace-contract";

const project = (name: string): ProjectConfig => ({
  id: "project-1",
  name,
  devices: ["A"],
  volumePrefix: "A_",
  requiredCopies: 2,
});

const task = (checksum: string): BackupTask => ({
  id: "task-1",
  name: "A001",
  projectId: "project-1",
  sourcePath: "/Volumes/SYNTHETIC-CARD",
  sourceVolumeUuid: "synthetic-volume",
  devices: ["A"],
  destinations: [],
  hashAlgorithm: "sha256",
  namingTemplate: "A001",
  status: "completed",
  totalFiles: 1,
  completedFiles: 1,
  totalBytes: 42,
  transferredBytes: 42,
  speedBps: 0,
  eta: 0,
  currentFile: "",
  verifyLog: [],
  fileRecords: [
    {
      name: "clip.mov",
      relativePath: "DCIM/clip.mov",
      size: 42,
      srcChecksum: checksum,
      destinations: [],
    },
  ],
});

const workspace = (
  projects: ProjectConfig[],
  tasks: BackupTask[],
  taskTombstones: Array<{
    id: string;
    revision: number;
    deletedAt: number;
  }> = [],
) =>
  sealWorkspaceState({
    schemaVersion: 2,
    revision: 4,
    committedAt: 4,
    projects,
    tasks,
    taskTombstones,
    projectTombstones: [],
    archiveEvidence: emptyArchiveEvidence(4),
  });

const exchangeState = (value: ReturnType<typeof workspace>) => ({
  projects: value.projects,
  tasks: value.tasks,
  templates: [],
  healthRecords: value.archiveEvidence!.healthRecords,
  archiveChanges: value.archiveEvidence!.changes,
  archiveReminders: value.archiveEvidence!.reminders,
  archiveRuns: value.archiveEvidence!.runs,
  taskTombstones: value.taskTombstones,
  projectTombstones: value.projectTombstones,
});

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "kocpy-packaged-workstation-"),
  );
  try {
    const storage = new Storage(root),
      identity = await loadOrCreateWorkstationIdentity(storage, "DIT-A"),
      renamed = await loadOrCreateWorkstationIdentity(storage, "DIT-A-Renamed");
    assert.equal(renamed.id, identity.id);

    const remoteWorkspace = workspace(
        [project("Remote Film")],
        [task("a".repeat(64))],
      ),
      payload = createWorkspacePackage({
        version: "0.1.31",
        identity: renamed,
        workspace: remoteWorkspace,
        templates: [],
      }),
      value = validateWorkspacePackage(payload),
      packageSha256 = createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
      localWorkspace = workspace(
        [project("Local Film")],
        [task("b".repeat(64))],
      ),
      preview = buildWorkspaceImportPreview({
        fileName: "synthetic.json",
        packageSha256,
        value,
        current: exchangeState(localWorkspace),
        localRevision: localWorkspace.revision,
        localDigest: localWorkspace.digest,
        localWorkstationId: "22222222-2222-4222-8222-222222222222",
        audits: [],
      }),
      nameConflict = preview.conflicts.find(
        (item) => item.kind === "project-field" && item.field === "name",
      );
    assert(nameConflict);
    assert.equal(nameConflict.defaultDecision, "local");
    const merged = applyWorkspaceMerge({
      current: exchangeState(localWorkspace),
      value,
      decisions: [
        { conflictId: nameConflict.id, decision: "incoming" as const },
      ],
      sourceWorkstationId: value.source!.workstationId,
      sourceWorkstationName: value.source!.displayName,
      exportId: value.source!.exportId,
      packageSha256,
      importedAt: 10,
    });
    assert.equal(merged.state.projects[0].name, "Remote Film");
    assert.equal(
      merged.state.tasks[0].fileRecords[0].srcChecksum,
      "b".repeat(64),
      "unselected task conflict must stay local",
    );

    const deletionWorkspace = workspace(
        [project("Remote Film")],
        [],
        [{ id: "task-1", revision: 5, deletedAt: 20 }],
      ),
      deletionPayload = createWorkspacePackage({
        version: "0.1.31",
        identity: renamed,
        workspace: deletionWorkspace,
        templates: [],
      }),
      deletionValue = validateWorkspacePackage(deletionPayload),
      deletionPreview = buildWorkspaceImportPreview({
        fileName: "deletion.json",
        packageSha256: "c".repeat(64),
        value: deletionValue,
        current: merged.state,
        localRevision: 5,
        localDigest: "d".repeat(64),
        audits: [],
      }),
      deletionConflict = deletionPreview.conflicts.find(
        (item) => item.kind === "task-remote-deletion",
      );
    assert(deletionConflict);
    assert.equal(
      applyWorkspaceMerge({
        current: merged.state,
        value: deletionValue,
        decisions: [],
      }).state.tasks.length,
      1,
    );
    assert.equal(
      applyWorkspaceMerge({
        current: merged.state,
        value: deletionValue,
        decisions: [{ conflictId: deletionConflict.id, decision: "incoming" }],
      }).state.tasks.length,
      0,
    );

    let recovery = false,
      rolledBack = false;
    await assert.rejects(
      commitWorkstationImportTransaction({
        writeRecovery: async () => {
          recovery = true;
        },
        stageTemplates: async () => undefined,
        commitAuthority: async () => {
          throw new Error("synthetic authority failure");
        },
        applyCommittedState: async () => undefined,
        writeAudit: async () => undefined,
        rollbackTemplates: async () => {
          rolledBack = true;
        },
        clearRecovery: async () => {
          recovery = false;
        },
      }),
      /authority failure/,
    );
    assert.equal(rolledBack, true);
    assert.equal(recovery, false);

    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        architecture: process.arch,
        stableIdentity: true,
        schema: value.schema,
        conflictsDefaultLocal: true,
        explicitIncomingOnly: true,
        tombstoneDefaultLocal: true,
        preCommitRollback: true,
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
