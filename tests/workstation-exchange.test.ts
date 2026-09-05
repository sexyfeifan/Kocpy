import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyArchiveEvidence } from "../src/main/archive-evidence";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { validateWorkspacePackage } from "../src/main/lifecycle";
import { Storage } from "../src/main/storage";
import type {
  BackupTask,
  ProjectConfig,
  ProjectTemplate,
  WorkspaceImportDecision,
} from "../src/main/types";
import {
  applyWorkspaceMerge,
  buildWorkspaceImportPreview,
  commitWorkstationImportTransaction,
  createWorkspacePackage,
  decisionsSha256,
  exchangeStateDigest,
  loadOrCreateWorkstationIdentity,
  loadWorkstationImportAudits,
  loadWorkstationImportRecovery,
  recoverWorkstationImportAudit,
  rollbackInterruptedWorkstationImport,
  workstationAuditId,
  workspacePackageIntegrity,
} from "../src/main/workstation-exchange";
import { sealWorkspaceState } from "../src/main/workspace-contract";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const project = (name = "Film"): ProjectConfig => ({
  id: "project-1",
  name,
  devices: ["A"],
  volumePrefix: "A_",
  requiredCopies: 2,
  handoffNotes: [{ id: "handoff-1", at: 1, operator: "A", note: "local" }],
});
const task = (id = "task-1", checksum = "a".repeat(64)): BackupTask => ({
  id,
  name: "A001",
  projectId: "project-1",
  sourcePath: "/Volumes/CARD",
  devices: ["A"],
  destinations: [],
  hashAlgorithm: "sha256",
  namingTemplate: "A001",
  shootingDate: "2026-09-02",
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
const workspace = (projects = [project()], tasks = [task()]) =>
  sealWorkspaceState({
    schemaVersion: 2,
    revision: 4,
    committedAt: 4,
    projects,
    tasks,
    taskTombstones: [],
    projectTombstones: [],
    archiveEvidence: emptyArchiveEvidence(4),
  });
const state = (value = workspace()) => ({
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
const identity = {
  schema: 1 as const,
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "DIT-A",
  createdAt: 1,
};
const template = (): ProjectTemplate => ({
  id: "template-doc",
  name: "Documentary",
  description: "Two verified copies",
  kind: "custom",
  productionType: "documentary",
  devices: ["A Cam", "Audio"],
  volumePrefix: "ROLL_",
  volumePrefixByDevice: { "A Cam": "A_", Audio: "S_" },
  devicePositions: { "A Cam": ["A"] },
  requiredCopies: 2,
  namingRule: "{shootingDate}/{device}/{card}",
  completionActions: ["report"],
  checklists: [
    {
      id: "check-source",
      phase: "start",
      label: "Check source",
      required: true,
    },
  ],
  crew: [{ id: "crew-dit", name: "Operator", role: "DIT" }],
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
});

describe("0.1.31 workstation exchange", () => {
  it("keeps a stable workstation id across hostname changes and fails closed on corruption", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-station-"),
    );
    temporary.push(directory);
    const storage = new Storage(directory),
      first = await loadOrCreateWorkstationIdentity(storage, "DIT-A"),
      renamed = await loadOrCreateWorkstationIdentity(storage, "DIT-A-Renamed");
    expect(renamed.id).toBe(first.id);
    expect(renamed.displayName).toBe("DIT-A-Renamed");
    await fs.writeFile(path.join(directory, "workstation-identity.json"), "{");
    await fs.writeFile(
      path.join(directory, "workstation-identity.json.bak"),
      "{",
    );
    await expect(
      loadOrCreateWorkstationIdentity(storage, "DIT-A"),
    ).rejects.toThrow(/停止生成新的身份/);
  });

  it("exports schema 3 with stable source, revision, tombstones and full integrity", () => {
    const local = workspace();
    local.taskTombstones.push({
      id: "deleted-task",
      deletedAt: 3,
      revision: 3,
    });
    const value = createWorkspacePackage({
      version: "0.1.31",
      identity,
      workspace: local,
      templates: [],
    });
    const validated = validateWorkspacePackage(value);
    expect(validated).toMatchObject({
      schema: 3,
      source: { workstationId: identity.id, displayName: "DIT-A" },
      workspace: { revision: 4, digest: local.digest },
    });
    expect(validated.workspace?.taskTombstones[0].id).toBe("deleted-task");
    expect(workspacePackageIntegrity(value)).toBe(value.integrity);
    expect(() =>
      validateWorkspacePackage({ ...value, version: "modified" }),
    ).toThrow(/完整性校验失败/);
  });

  it("rejects malformed imported templates before merge or persistence", () => {
    const invalidDevice = { ...template(), devices: ["../escape"] };
    expect(() =>
      validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: workspace(),
          templates: [invalidDevice],
        }),
      ),
    ).toThrow(/模板设备名称无效/);

    const invalidChecklist = {
      ...template(),
      checklists: [
        {
          id: "check-source",
          phase: "unknown",
          label: "Check source",
          required: true,
        },
      ],
    } as unknown as ProjectTemplate;
    expect(() =>
      validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: workspace(),
          templates: [invalidChecklist],
        }),
      ),
    ).toThrow(/模板检查项无效/);
  });

  it("rejects unsafe project path fields before they can become future backup settings", () => {
    const unsafe = workspace([
      { ...project(), devices: ["../Camera"], projectFolderName: "../escape" },
    ]);
    expect(() =>
      validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: unsafe,
          templates: [],
        }),
      ),
    ).toThrow(/项目设备名称无效|项目文件夹名称无效/);
  });

  it("previews conflicts without mutating and defaults to local values", () => {
    const local = workspace(),
      remoteProject = {
        ...project("Remote Film"),
        requiredCopies: 1,
        handoffNotes: [
          { id: "handoff-1", at: 1, operator: "B", note: "conflict" },
          { id: "handoff-2", at: 2, operator: "B", note: "new" },
        ],
      },
      remote = workspace([remoteProject], [task("task-1", "b".repeat(64))]),
      value = validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: remote,
          templates: [],
        }),
      ),
      before = exchangeStateDigest(state(local)),
      preview = buildWorkspaceImportPreview({
        fileName: "station.json",
        packageSha256: "c".repeat(64),
        value,
        current: state(local),
        localRevision: local.revision,
        localDigest: local.digest,
        audits: [],
      });
    expect(preview.conflicts.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["project-field", "project-evidence", "task-id"]),
    );
    expect(
      preview.conflicts.every((item) => item.defaultDecision === "local"),
    ).toBe(true);
    expect(exchangeStateDigest(state(local))).toBe(before);
    const merged = applyWorkspaceMerge({
      current: state(local),
      value,
      decisions: [],
    });
    expect(merged.state.projects[0].name).toBe("Film");
    expect(merged.state.projects[0].handoffNotes).toEqual([
      project().handoffNotes![0],
      remoteProject.handoffNotes[1],
    ]);
    expect(merged.state.tasks[0].fileRecords[0].srcChecksum).toBe(
      "a".repeat(64),
    );
    expect(merged.unresolvedConflictIds.length).toBe(preview.conflicts.length);
  });

  it("applies only explicit incoming conflict choices and keeps the rest local", () => {
    const local = workspace(),
      remote = workspace(
        [{ ...project("Remote Film"), requiredCopies: 1 }],
        [task("task-1", "b".repeat(64))],
      ),
      value = validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: remote,
          templates: [],
        }),
      ),
      preview = buildWorkspaceImportPreview({
        fileName: "station.json",
        packageSha256: "d".repeat(64),
        value,
        current: state(local),
        localRevision: local.revision,
        localDigest: local.digest,
        audits: [],
      }),
      nameConflict = preview.conflicts.find(
        (item) => item.kind === "project-field" && item.field === "name",
      )!,
      decisions: WorkspaceImportDecision[] = [
        { conflictId: nameConflict.id, decision: "incoming" },
      ],
      merged = applyWorkspaceMerge({
        current: state(local),
        value,
        decisions,
      });
    expect(merged.state.projects[0].name).toBe("Remote Film");
    expect(merged.state.projects[0].requiredCopies).toBe(2);
    expect(merged.state.tasks[0].fileRecords[0].srcChecksum).toBe(
      "a".repeat(64),
    );
    expect(decisionsSha256(decisions)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not resurrect local tombstones or apply remote deletions without an explicit choice", () => {
    const local = workspace([], []),
      incoming = workspace([project()], [task()]);
    local.projectTombstones = [{ id: "project-1", deletedAt: 10, revision: 5 }];
    local.taskTombstones = [{ id: "task-1", deletedAt: 10, revision: 5 }];
    const value = validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: incoming,
          templates: [],
        }),
      ),
      preview = buildWorkspaceImportPreview({
        fileName: "station.json",
        packageSha256: "e".repeat(64),
        value,
        current: state(local),
        localRevision: local.revision,
        localDigest: local.digest,
        audits: [],
      }),
      safe = applyWorkspaceMerge({
        current: state(local),
        value,
        decisions: [],
      });
    expect(preview.conflicts.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["project-local-deletion", "task-local-deletion"]),
    );
    expect(safe.state.projects).toHaveLength(0);
    expect(safe.state.tasks).toHaveLength(0);
    expect(safe.state.projectTombstones).toHaveLength(1);
    expect(safe.state.taskTombstones).toHaveLength(1);
    const decisions = preview.conflicts.map((item) => ({
      conflictId: item.id,
      decision: "incoming" as const,
    }));
    const restored = applyWorkspaceMerge({
      current: state(local),
      value,
      decisions,
    });
    expect(restored.state.projects).toHaveLength(1);
    expect(restored.state.tasks).toHaveLength(1);
    expect(restored.state.projectTombstones).toHaveLength(0);
    expect(restored.state.taskTombstones).toHaveLength(0);
  });

  it("blocks a project deletion choice that would leave a task orphaned", () => {
    const local = workspace(),
      remote = workspace([], []);
    remote.projectTombstones = [
      { id: "project-1", deletedAt: 10, revision: 5 },
    ];
    remote.taskTombstones = [{ id: "task-1", deletedAt: 10, revision: 5 }];
    const value = validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: remote,
          templates: [],
        }),
      ),
      preview = buildWorkspaceImportPreview({
        fileName: "station.json",
        packageSha256: "9".repeat(64),
        value,
        current: state(local),
        localRevision: local.revision,
        localDigest: local.digest,
        audits: [],
      }),
      projectDeletion = preview.conflicts.find(
        (item) => item.kind === "project-remote-deletion",
      )!,
      taskDeletion = preview.conflicts.find(
        (item) => item.kind === "task-remote-deletion",
      )!;
    expect(() =>
      applyWorkspaceMerge({
        current: state(local),
        value,
        decisions: [{ conflictId: projectDeletion.id, decision: "incoming" }],
      }),
    ).toThrow(/找不到所属项目/);
    const deleted = applyWorkspaceMerge({
      current: state(local),
      value,
      decisions: [
        { conflictId: projectDeletion.id, decision: "incoming" },
        { conflictId: taskDeletion.id, decision: "incoming" },
      ],
    });
    expect(deleted.state.projects).toHaveLength(0);
    expect(deleted.state.tasks).toHaveLength(0);
  });

  it("treats identical content under a different task id as a visible conflict", () => {
    const local = workspace(),
      incoming = workspace([project()], [task("task-remote")]),
      value = validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: incoming,
          templates: [],
        }),
      ),
      preview = buildWorkspaceImportPreview({
        fileName: "station.json",
        packageSha256: "f".repeat(64),
        value,
        current: state(local),
        localRevision: local.revision,
        localDigest: local.digest,
        audits: [],
      }),
      content = preview.conflicts.find(
        (item) => item.kind === "task-content-duplicate",
      )!;
    expect(content).toBeTruthy();
    expect(
      applyWorkspaceMerge({ current: state(local), value, decisions: [] }).state
        .tasks,
    ).toHaveLength(1);
    expect(
      applyWorkspaceMerge({
        current: state(local),
        value,
        decisions: [{ conflictId: content.id, decision: "incoming" }],
      }).state.tasks,
    ).toHaveLength(2);
  });

  it("recovers a committed import audit after an interruption without replaying the merge", () => {
    const packageSha256 = "1".repeat(64),
      decisionDigest = decisionsSha256([]),
      expectedExchangeDigest = exchangeStateDigest(state()),
      recovery = {
        schema: 1 as const,
        previewId: "preview",
        packageSha256,
        decisionsSha256: decisionDigest,
        decisions: [],
        expectedExchangeDigest,
        sourceWorkstationName: "DIT-B",
        operator: "Operator",
        previewedRevision: 4,
        previewedDigest: "3".repeat(64),
        previewedExchangeDigest: "6".repeat(64),
        previousTemplates: [],
        previousTemplatesDigest: createHash("sha256")
          .update(JSON.stringify([]))
          .digest("hex"),
        importedAt: 10,
        result: {
          projectsAdded: 0,
          projectsUpdated: 0,
          tasksAdded: 1,
          duplicates: 0,
          conflicts: [],
          importedAt: 10,
        },
      },
      recovered = recoverWorkstationImportAudit({
        recovery,
        currentExchangeDigest: expectedExchangeDigest,
        currentRevision: 5,
        currentDigest: "4".repeat(64),
        audits: [],
      });
    expect(recovered).toMatchObject({
      id: workstationAuditId(packageSha256, decisionDigest),
      importedRevision: 5,
      result: { repeated: true, tasksAdded: 1 },
    });
    expect(
      recoverWorkstationImportAudit({
        recovery,
        currentExchangeDigest: "5".repeat(64),
        currentRevision: 5,
        currentDigest: "4".repeat(64),
        audits: [],
      }),
    ).toBeUndefined();
  });

  it("loads a valid recovery, rolls back only at the exact baseline, and fails closed on corruption", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-recovery-"),
    );
    temporary.push(directory);
    const storage = new Storage(directory),
      previousTemplates = [
        {
          id: "template-1",
          name: "Before",
          productionType: "custom" as const,
          devices: ["A"],
          volumePrefix: "A_",
          requiredCopies: 2,
        },
      ],
      recovery = {
        schema: 1 as const,
        previewId: "preview",
        packageSha256: "1".repeat(64),
        decisionsSha256: decisionsSha256([]),
        decisions: [],
        expectedExchangeDigest: "3".repeat(64),
        sourceWorkstationName: "DIT-B",
        operator: "Operator",
        previewedRevision: 4,
        previewedDigest: "4".repeat(64),
        previewedExchangeDigest: "5".repeat(64),
        previousTemplates,
        previousTemplatesDigest: createHash("sha256")
          .update(JSON.stringify(previousTemplates))
          .digest("hex"),
        importedAt: 10,
        result: {
          projectsAdded: 0,
          projectsUpdated: 0,
          tasksAdded: 0,
          duplicates: 0,
          conflicts: [],
          importedAt: 10,
        },
      };
    await storage.write("workstation-import-recovery.json", recovery);
    expect(await loadWorkstationImportRecovery(storage)).toEqual(recovery);
    expect(
      rollbackInterruptedWorkstationImport({
        recovery,
        currentRevision: 4,
        currentDigest: "4".repeat(64),
      }),
    ).toEqual(previousTemplates);
    expect(
      rollbackInterruptedWorkstationImport({
        recovery,
        currentRevision: 5,
        currentDigest: "6".repeat(64),
      }),
    ).toBeUndefined();

    await fs.writeFile(
      path.join(directory, "workstation-import-recovery.json"),
      "{",
    );
    await fs.writeFile(
      path.join(directory, "workstation-import-recovery.json.bak"),
      "{",
    );
    await expect(loadWorkstationImportRecovery(storage)).rejects.toThrow(
      /恢复记录损坏/,
    );
  });

  it("loads append-only import audits and fails closed when both copies are corrupt", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-audit-"));
    temporary.push(directory);
    const storage = new Storage(directory),
      packageSha256 = "a".repeat(64),
      decisionsDigest = decisionsSha256([]),
      audit = {
        id: workstationAuditId(packageSha256, decisionsDigest),
        sourceWorkstationId: identity.id,
        sourceWorkstationName: identity.displayName,
        exportId: "22222222-2222-4222-8222-222222222222",
        packageSha256,
        decisionsSha256: decisionsDigest,
        decisions: [],
        operator: "Operator",
        previewedRevision: 4,
        previewedDigest: "c".repeat(64),
        previewedExchangeDigest: "d".repeat(64),
        importedRevision: 5,
        importedDigest: "e".repeat(64),
        importedExchangeDigest: "f".repeat(64),
        importedAt: 10,
        result: {
          projectsAdded: 1,
          projectsUpdated: 0,
          tasksAdded: 1,
          duplicates: 0,
          conflicts: [],
          importedAt: 10,
        },
      };
    await storage.write("workstation-import-audit.json", [audit]);
    expect(await loadWorkstationImportAudits(storage)).toEqual([audit]);

    await fs.writeFile(
      path.join(directory, "workstation-import-audit.json"),
      "{",
    );
    await fs.writeFile(
      path.join(directory, "workstation-import-audit.json.bak"),
      "{",
    );
    await expect(loadWorkstationImportAudits(storage)).rejects.toThrow(
      /导入审计损坏/,
    );
  });

  it("replaces the settled engine task set exactly after an accepted remote deletion", () => {
    const engine = new BackupEngine(),
      stale = { ...task("deleted-task"), errorMessage: "must disappear" },
      retained = task("retained-task");
    engine.loadTask(stale);
    engine.loadTask(retained);
    engine.replaceSettledTasks([{ ...retained, errorMessage: undefined }]);
    expect(engine.getTask("deleted-task")).toBeUndefined();
    expect(engine.getTask("retained-task")?.errorMessage).toBeUndefined();

    const pending = { ...task("pending-task"), status: "pending" as const };
    engine.loadTask(pending);
    expect(() => engine.replaceSettledTasks([])).toThrow(/未结束/);
    expect(engine.getTask("pending-task")).toBeTruthy();
  });

  it("gives each exported source evidence a truthful per-export id without false conflicts", () => {
    const local = workspace(),
      firstPackage = validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: local,
          templates: [],
        }),
      ),
      firstSource = firstPackage.source!,
      first = applyWorkspaceMerge({
        current: state(workspace([], [])),
        value: firstPackage,
        decisions: [],
        sourceWorkstationId: firstSource.workstationId,
        sourceWorkstationName: firstSource.displayName,
        exportId: firstSource.exportId,
        packageSha256: "7".repeat(64),
        importedAt: 10,
      }),
      secondPackage = validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: local,
          templates: [],
        }),
      ),
      secondSource = secondPackage.source!,
      preview = buildWorkspaceImportPreview({
        fileName: "second.json",
        packageSha256: "8".repeat(64),
        value: secondPackage,
        current: first.state,
        localRevision: 5,
        localDigest: "9".repeat(64),
        audits: [],
      }),
      second = applyWorkspaceMerge({
        current: first.state,
        value: secondPackage,
        decisions: [],
        sourceWorkstationId: secondSource.workstationId,
        sourceWorkstationName: secondSource.displayName,
        exportId: secondSource.exportId,
        packageSha256: "8".repeat(64),
        importedAt: 20,
      });
    expect(firstSource.exportId).not.toBe(secondSource.exportId);
    expect(
      preview.conflicts.some((item) => item.kind === "project-evidence"),
    ).toBe(false);
    expect(second.state.projects[0].workstationSources).toHaveLength(2);
    expect(
      new Set(
        second.state.projects[0].workstationSources!.map((item) => item.id),
      ).size,
    ).toBe(2);
  });

  it("rejects unfinished schema 3 tasks and duplicate append-only evidence ids", () => {
    const unfinished = workspace(
      [project()],
      [{ ...task(), status: "running" as const }],
    );
    expect(() =>
      createWorkspacePackage({
        version: "0.1.31",
        identity,
        workspace: unfinished,
        templates: [],
      }),
    ).toThrow(/未结束/);

    const duplicateEvidence = workspace([
      {
        ...project(),
        handoffNotes: [project().handoffNotes![0], project().handoffNotes![0]],
      },
    ]);
    expect(() =>
      validateWorkspacePackage(
        createWorkspacePackage({
          version: "0.1.31",
          identity,
          workspace: duplicateEvidence,
          templates: [],
        }),
      ),
    ).toThrow(/标识重复或无效/);
  });

  it("rolls back staged templates on authority failure and retains recovery on audit failure", async () => {
    let recovery = false,
      templates = "local",
      applied = false,
      rollbackCalls = 0;
    await expect(
      commitWorkstationImportTransaction({
        writeRecovery: async () => {
          recovery = true;
        },
        stageTemplates: async () => {
          templates = "incoming";
        },
        commitAuthority: async () => {
          throw new Error("authority failed");
        },
        applyCommittedState: async () => {
          applied = true;
        },
        writeAudit: async () => undefined,
        rollbackTemplates: async () => {
          rollbackCalls++;
          templates = "local";
        },
        clearRecovery: async () => {
          recovery = false;
        },
      }),
    ).rejects.toThrow("authority failed");
    expect({ recovery, templates, applied, rollbackCalls }).toEqual({
      recovery: false,
      templates: "local",
      applied: false,
      rollbackCalls: 1,
    });

    await expect(
      commitWorkstationImportTransaction({
        writeRecovery: async () => {
          recovery = true;
        },
        stageTemplates: async () => {
          templates = "incoming";
        },
        commitAuthority: async () => ({ revision: 5 }),
        applyCommittedState: async () => {
          applied = true;
        },
        writeAudit: async () => {
          throw new Error("audit failed");
        },
        rollbackTemplates: async () => {
          rollbackCalls++;
          templates = "local";
        },
        clearRecovery: async () => {
          recovery = false;
        },
      }),
    ).rejects.toThrow("audit failed");
    expect(recovery).toBe(true);
    expect(templates).toBe("incoming");
    expect(applied).toBe(true);
    expect(rollbackCalls).toBe(1);
  });
});
