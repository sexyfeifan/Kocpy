import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { analyzeBackupSelection, finalizeBackupSelection } from "../src/main/backup-selection";
import { WorkspaceRepository } from "../src/main/workspace";
import { Storage } from "../src/main/storage";
import { CatalogDatabase } from "../src/main/catalog";
import { validateWorkspacePackage } from "../src/main/lifecycle";
import { createWorkspacePackage, applyWorkspaceMerge, workspacePackageIntegrity } from "../src/main/workstation-exchange";
import { taskTrustState, taskMeetsCopyRequirement } from "../src/common/task-trust";
import type { BackupTask, ProjectConfig } from "../src/main/types";
import { validateWorkspaceState } from "../src/main/workspace-contract";

let root: string, task: BackupTask;
const project: ProjectConfig = { id: "roundtrip-project", name: "Isolated scope roundtrip", devices: ["A"], volumePrefix: "A", requiredCopies: 1 };
const identity = { schema: 1 as const, id: "11111111-1111-4111-8111-111111111111", displayName: "Synthetic workstation A", createdAt: 1 };
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-selection-roundtrip-")));
  const sourcePath = path.join(root, "source"); await fs.mkdir(sourcePath);
  await fs.writeFile(path.join(sourcePath, "old.mov"), "old simulated content");
  await fs.writeFile(path.join(sourcePath, "new.mov"), "new simulated content");
  const deps = { identifyVolume: async () => ({ id: "source", uuid: "source", name: "source", device: "disk1" }),
    readEmbeddedDate: async (file: string) => file.endsWith("old.mov") ? "2026-10-14" : "2026-10-15" };
  const preview = await analyzeBackupSelection({ sourcePath, projectId: project.id }, deps);
  const selection = await finalizeBackupSelection(preview, { selectedDates: ["2026-10-15"], operator: "Fixture operator",
    allowUnprotectedExclusions: true }, deps);
  task = new BackupEngine().createTask({ sourcePath, selection, projectId: project.id, name: "Selected scope",
    destinationPaths: [path.join(root, "destination")], devices: ["A"], namingTemplate: "A001", shootingDate: "2026-10-15", hashAlgorithm: "sha256" });
  task.status = "completed"; task.sourceVolumeUuid = "source";
  task.destinations[0].verified = true; task.destinations[0].volumeUuid = "destination";
  task.completedFiles = task.totalFiles;
  task.fileRecords = selection.sourceFiles.filter((file) => selection.includedPaths.includes(file.relativePath)).map((file) => ({
    name: file.relativePath, relativePath: file.relativePath, size: file.size, srcChecksum: file.sha256,
    destinations: [{ path: path.join(root, "destination", file.relativePath), checksum: file.sha256, verified: true }],
  }));
});
afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

async function repository(name: string) {
  const directory = path.join(root, name); await fs.mkdir(directory);
  const storage = new Storage(directory), catalog = new CatalogDatabase(directory), workspace = new WorkspaceRepository(storage, catalog);
  await workspace.initialize(); return { directory, storage, catalog, workspace };
}
function expectScope(actual: BackupTask) {
  expect(actual.selection).toEqual(task.selection);
  expect(actual.inventoryScope).toEqual(task.inventoryScope);
  expect(actual.totalFiles).toBe(1); expect(actual.selection!.sourceFiles).toHaveLength(2);
  expect(taskTrustState(actual)).toMatchObject({ contentVerified: true, countableCopies: 0 });
  expect(taskMeetsCopyRequirement(actual, 1)).toBe(false);
}
const exchangeState = (repository: WorkspaceRepository) => ({
  projects: repository.getProjects(), tasks: repository.getTasks(), templates: [],
  healthRecords: repository.getArchiveEvidence().healthRecords, archiveChanges: repository.getArchiveEvidence().changes,
  archiveReminders: repository.getArchiveEvidence().reminders, archiveRuns: repository.getArchiveEvidence().runs,
  taskTombstones: repository.snapshot.taskTombstones, projectTombstones: repository.snapshot.projectTombstones,
});

describe("selected scope persists across isolated workstation and cold-archive boundaries", () => {
  it("round-trips authority, compatibility mirror, catalog and engine reload without promoting whole-card trust", async () => {
    const fixture = await repository("persisted-A");
    await fixture.workspace.commit({ projects: [project], tasks: [task], syncCatalog: true });
    expectScope(fixture.workspace.getTasks()[0]);
    expectScope(JSON.parse(await fs.readFile(path.join(fixture.directory, "tasks.json"), "utf8"))[0]);
    expectScope((await fixture.catalog.loadTasks())[0]);
    expectScope(validateWorkspaceState(JSON.parse(await fs.readFile(path.join(fixture.directory, "workspace-state.json"), "utf8"))).tasks[0]);
    const reopened = new WorkspaceRepository(new Storage(fixture.directory), new CatalogDatabase(fixture.directory));
    await reopened.initialize(); expectScope(reopened.getTasks()[0]);
    const engine = new BackupEngine(); engine.replaceSettledTasks(reopened.getTasks()); expectScope(engine.getAllTasks()[0]);
  });

  it("exports a real JSON workstation package and imports it into a separate empty simulated workstation", async () => {
    const macA = await repository("exchange-A"), macB = await repository("exchange-B");
    await macA.workspace.commit({ projects: [project], tasks: [task], syncCatalog: true });
    const envelope = createWorkspacePackage({ version: "0.1.49", identity, workspace: macA.workspace.snapshot, templates: [] });
    const file = path.join(root, "workspace-export.json"); await fs.writeFile(file, JSON.stringify(envelope));
    const bytes = await fs.readFile(file), payload = validateWorkspacePackage(JSON.parse(bytes.toString("utf8")));
    expectScope(payload.tasks[0]);
    const merged = applyWorkspaceMerge({ current: exchangeState(macB.workspace), value: payload, decisions: [],
      sourceWorkstationId: identity.id, sourceWorkstationName: identity.displayName, exportId: envelope.source.exportId,
      packageSha256: hash(bytes), importedAt: Date.now() });
    expect(merged.result.tasksAdded).toBe(1);
    await macB.workspace.commit({ projects: merged.state.projects, tasks: merged.state.tasks, syncCatalog: true });
    expectScope(macB.workspace.getTasks()[0]);
    const repeated = applyWorkspaceMerge({ current: exchangeState(macB.workspace), value: payload, decisions: [] });
    expect(repeated.result.tasksAdded).toBe(0); expect(repeated.state.tasks).toHaveLength(1); expectScope(repeated.state.tasks[0]);
    expect(repeated.state.tasks[0].workstationSources?.[0].workstationId).toBe(identity.id);
  });

  it("retains scope in the production cold-archive envelope/gzip/validation/restore sequence", async () => {
    // This invokes production persistence and package validation, reproducing
    // the IPC envelope/compression sequence without real dialogs or user data.
    const macA = await repository("cold-A"), macB = await repository("cold-B");
    await macA.workspace.commit({ projects: [project], tasks: [task], syncCatalog: true });
    const evidence = macA.workspace.getArchiveEvidence();
    const body = { schema: 3, application: "Kocpy", kind: "cold-archive", version: "0.1.49", createdAt: Date.now(),
      project: macA.workspace.getProjects()[0], tasks: macA.workspace.getTasks(), archiveEvidence: {
        sourceDigest: evidence.digest, healthRecords: evidence.healthRecords, changes: evidence.changes,
        reminders: evidence.reminders, runs: evidence.runs,
      } };
    const payload = { ...body, integrity: workspacePackageIntegrity(body) }, archive = path.join(root, "synthetic-cold.kocpy.gz");
    await fs.writeFile(archive, gzipSync(Buffer.from(JSON.stringify(payload))));
    const restored = JSON.parse(gunzipSync(await fs.readFile(archive)).toString("utf8"));
    expect(workspacePackageIntegrity(restored)).toBe(payload.integrity);
    validateWorkspacePackage({ schema: 1, application: "Kocpy", projects: [restored.project], tasks: restored.tasks,
      templates: [], healthRecords: [], archiveChanges: [], archiveReminders: [], archiveRuns: [] });
    await macB.workspace.commit({ projects: [{ ...restored.project, status: "active" }], tasks: restored.tasks, syncCatalog: true });
    expectScope(macB.workspace.getTasks()[0]); expectScope((await macB.catalog.loadTasks())[0]);
    const tampered = structuredClone(restored.tasks); tampered[0].selection.operator = "unrecorded change";
    await expect(macB.workspace.commit({ tasks: tampered })).rejects.toThrow(/摘要|筛选|范围/);
    expectScope(macB.workspace.getTasks()[0]);
  });
});
