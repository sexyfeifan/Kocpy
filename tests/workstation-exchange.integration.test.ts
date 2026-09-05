import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogDatabase } from "../src/main/catalog";
import { Storage } from "../src/main/storage";
import type {
  BackupTask,
  ProjectConfig,
  WorkstationIdentity,
  WorkspaceImportDecision,
} from "../src/main/types";
import {
  applyWorkspaceMerge,
  buildWorkspaceImportPreview,
  createWorkspacePackage,
  exchangeStateDigest,
  loadOrCreateWorkstationIdentity,
  type ValidatedWorkspacePackage,
  type WorkspaceExchangeState,
} from "../src/main/workstation-exchange";
import { validateWorkspacePackage } from "../src/main/lifecycle";
import { WorkspaceRepository } from "../src/main/workspace";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const project = (id: string, name: string): ProjectConfig => ({
  id,
  name,
  devices: ["A"],
  volumePrefix: "A_",
  requiredCopies: 2,
});

const task = (id: string, projectId: string, checksum: string): BackupTask => ({
  id,
  name: id,
  projectId,
  sourcePath: `/Volumes/${id}`,
  sourceVolumeUuid: `volume-${id}`,
  devices: ["A"],
  destinations: [],
  hashAlgorithm: "sha256",
  namingTemplate: id,
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
      name: `${id}.mov`,
      relativePath: `DCIM/${id}.mov`,
      size: 42,
      srcChecksum: checksum,
      destinations: [],
    },
  ],
});

async function station(displayName: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-exchange-"));
  roots.push(root);
  const storage = new Storage(root),
    repository = new WorkspaceRepository(storage, new CatalogDatabase(root));
  await repository.initialize();
  const identity = await loadOrCreateWorkstationIdentity(storage, displayName);
  return { root, storage, repository, identity };
}

const exchangeState = (
  repository: WorkspaceRepository,
): WorkspaceExchangeState => ({
  projects: repository.getProjects(),
  tasks: repository.getTasks(),
  templates: [],
  healthRecords: repository.getArchiveEvidence().healthRecords,
  archiveChanges: repository.getArchiveEvidence().changes,
  archiveReminders: repository.getArchiveEvidence().reminders,
  archiveRuns: repository.getArchiveEvidence().runs,
  taskTombstones: structuredClone(repository.snapshot.taskTombstones),
  projectTombstones: structuredClone(repository.snapshot.projectTombstones),
});

const exported = (
  repository: WorkspaceRepository,
  identity: WorkstationIdentity,
) => {
  const raw = createWorkspacePackage({
      version: "0.1.31",
      identity,
      workspace: repository.snapshot,
      templates: [],
    }),
    bytes = JSON.stringify(raw);
  return {
    value: validateWorkspacePackage(raw),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

async function importPackage(input: {
  repository: WorkspaceRepository;
  identity: WorkstationIdentity;
  package: { value: ValidatedWorkspacePackage; sha256: string };
  decide?: (
    preview: ReturnType<typeof buildWorkspaceImportPreview>,
  ) => WorkspaceImportDecision[];
}) {
  const current = exchangeState(input.repository),
    preview = buildWorkspaceImportPreview({
      fileName: "exchange.json",
      packageSha256: input.package.sha256,
      value: input.package.value,
      current,
      localRevision: input.repository.snapshot.revision,
      localDigest: input.repository.snapshot.digest,
      localWorkstationId: input.identity.id,
      audits: [],
    }),
    source = input.package.value.source!,
    merged = applyWorkspaceMerge({
      current,
      value: input.package.value,
      decisions: input.decide?.(preview) || [],
      sourceWorkstationId: source.workstationId,
      sourceWorkstationName: source.displayName,
      exportId: source.exportId,
      packageSha256: input.package.sha256,
      importedAt: source.exportedAt + 1,
    });
  await input.repository.commit({
    tasks: merged.state.tasks,
    projects: merged.state.projects,
    archiveEvidence: input.repository.getArchiveEvidence(),
    taskTombstones: merged.state.taskTombstones,
    projectTombstones: merged.state.projectTombstones,
    syncCatalog: true,
  });
  return { preview, merged };
}

async function reopen(root: string) {
  const repository = new WorkspaceRepository(
    new Storage(root),
    new CatalogDatabase(root),
  );
  await repository.initialize();
  return repository;
}

describe("0.1.31 isolated two-workspace exchange", () => {
  it("keeps A→B→A and B→A→B deterministic across conflict, repeat, tombstone and restart", async () => {
    const a = await station("DIT-A"),
      b = await station("DIT-B");
    expect(a.identity.id).not.toBe(b.identity.id);

    await a.repository.commit({
      projects: [project("shared", "Shared Film")],
      tasks: [task("task-a", "shared", "a".repeat(64))],
      syncCatalog: true,
    });
    await b.repository.commit({
      projects: [project("b-only", "B Unit")],
      tasks: [task("task-b", "b-only", "b".repeat(64))],
      syncCatalog: true,
    });

    const aToB = await importPackage({
      repository: b.repository,
      identity: b.identity,
      package: exported(a.repository, a.identity),
    });
    expect(aToB.preview.summary).toMatchObject({
      projectsAdded: 1,
      tasksAdded: 1,
      conflicts: 0,
    });
    const bToA = await importPackage({
      repository: a.repository,
      identity: a.identity,
      package: exported(b.repository, b.identity),
    });
    expect(bToA.preview.summary.projectsAdded).toBe(1);
    expect(new Set(a.repository.getProjects().map((item) => item.id))).toEqual(
      new Set(["shared", "b-only"]),
    );
    expect(new Set(b.repository.getProjects().map((item) => item.id))).toEqual(
      new Set(["shared", "b-only"]),
    );

    await a.repository.commit({
      projects: a.repository
        .getProjects()
        .map((item) =>
          item.id === "shared" ? { ...item, name: "A Edit" } : item,
        ),
    });
    await b.repository.commit({
      projects: b.repository
        .getProjects()
        .map((item) =>
          item.id === "shared" ? { ...item, name: "B Edit" } : item,
        ),
    });
    const conflictImport = await importPackage({
      repository: a.repository,
      identity: a.identity,
      package: exported(b.repository, b.identity),
      decide: (preview) =>
        preview.conflicts
          .filter(
            (item) => item.kind === "project-field" && item.field === "name",
          )
          .map((item) => ({
            conflictId: item.id,
            decision: "incoming" as const,
          })),
    });
    expect(
      conflictImport.preview.conflicts.find(
        (item) => item.kind === "project-field" && item.field === "name",
      )?.defaultDecision,
    ).toBe("local");
    expect(
      a.repository.getProjects().find((item) => item.id === "shared")?.name,
    ).toBe("B Edit");

    const aReturn = exported(a.repository, a.identity),
      firstReturn = await importPackage({
        repository: b.repository,
        identity: b.identity,
        package: aReturn,
      }),
      digestAfterFirst = exchangeStateDigest(exchangeState(b.repository)),
      repeated = applyWorkspaceMerge({
        current: exchangeState(b.repository),
        value: aReturn.value,
        decisions: [],
        sourceWorkstationId: aReturn.value.source!.workstationId,
        sourceWorkstationName: aReturn.value.source!.displayName,
        exportId: aReturn.value.source!.exportId,
        packageSha256: aReturn.sha256,
        importedAt: aReturn.value.source!.exportedAt + 1,
      });
    expect(firstReturn.preview.conflicts).toHaveLength(0);
    expect(exchangeStateDigest(repeated.state)).toBe(digestAfterFirst);

    const withoutTaskA = a.repository
      .getTasks()
      .filter((item) => item.id !== "task-a");
    await a.repository.commit({ tasks: withoutTaskA, syncCatalog: true });
    const deletionPackage = exported(a.repository, a.identity),
      safePreviewState = exchangeState(b.repository),
      safePreview = buildWorkspaceImportPreview({
        fileName: "deletion.json",
        packageSha256: deletionPackage.sha256,
        value: deletionPackage.value,
        current: safePreviewState,
        localRevision: b.repository.snapshot.revision,
        localDigest: b.repository.snapshot.digest,
        localWorkstationId: b.identity.id,
        audits: [],
      }),
      deletionConflict = safePreview.conflicts.find(
        (item) =>
          item.kind === "task-remote-deletion" && item.entityId === "task-a",
      )!;
    expect(deletionConflict.defaultDecision).toBe("local");
    expect(
      applyWorkspaceMerge({
        current: safePreviewState,
        value: deletionPackage.value,
        decisions: [],
      }).state.tasks.some((item) => item.id === "task-a"),
    ).toBe(true);
    await importPackage({
      repository: b.repository,
      identity: b.identity,
      package: deletionPackage,
      decide: () => [{ conflictId: deletionConflict.id, decision: "incoming" }],
    });

    const reopenedA = await reopen(a.root),
      reopenedB = await reopen(b.root);
    expect(reopenedA.getTasks().some((item) => item.id === "task-a")).toBe(
      false,
    );
    expect(reopenedB.getTasks().some((item) => item.id === "task-a")).toBe(
      false,
    );
    expect(
      reopenedB.snapshot.taskTombstones.some((item) => item.id === "task-a"),
    ).toBe(true);

    const bReturn = exported(reopenedB, b.identity);
    await importPackage({
      repository: reopenedA,
      identity: a.identity,
      package: bReturn,
    });
    expect(reopenedA.getTasks().some((item) => item.id === "task-a")).toBe(
      false,
    );
    expect(
      reopenedA.snapshot.taskTombstones.some((item) => item.id === "task-a"),
    ).toBe(true);
  });
});
