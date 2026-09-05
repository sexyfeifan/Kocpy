import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogDatabase } from "../src/main/catalog";
import { Storage } from "../src/main/storage";
import type { BackupTask, ProjectConfig } from "../src/main/types";
import { WorkspaceRepository } from "../src/main/workspace";
import {
  sealWorkspaceState,
  validateWorkspaceState,
} from "../src/main/workspace-contract";
import { updateArchiveEvidence } from "../src/main/archive-evidence";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-workspace-"));
  roots.push(root);
  return {
    root,
    storage: new Storage(root),
    catalog: new CatalogDatabase(root),
  };
}

function task(id: string, checkpoint = 1): BackupTask {
  return {
    id,
    name: id,
    sourcePath: `/Volumes/${id}`,
    devices: [],
    destinations: [],
    hashAlgorithm: "sha256",
    namingTemplate: "{name}",
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
    createdAt: 1,
    lastCheckpointAt: checkpoint,
  };
}

function taskWithFiles(id: string, names: string[]): BackupTask {
  const next = task(id);
  next.projectId = "project-files";
  next.fileRecords = names.map((name, index) => ({
    name,
    relativePath: `DCIM/${name}`,
    size: index + 1,
    srcChecksum: String(index + 1).padStart(64, "0"),
    destinations: [
      {
        path: `/Volumes/BACKUP/${id}/DCIM/${name}`,
        checksum: String(index + 1).padStart(64, "0"),
        verified: true,
      },
    ],
  }));
  next.totalFiles = next.completedFiles = next.fileRecords.length;
  next.totalBytes = next.transferredBytes = next.fileRecords.reduce(
    (total, file) => total + file.size,
    0,
  );
  return next;
}

function project(id: string): ProjectConfig {
  return { id, name: id, devices: ["A"], volumePrefix: "A_" };
}

describe("workspace authority and reconciliation", () => {
  it("upgrades schema 1 once and imports legacy archive evidence into the authority", async () => {
    const { root, storage, catalog } = await fixture(),
      legacy = sealWorkspaceState({
        schemaVersion: 1,
        revision: 7,
        committedAt: 10,
        tasks: [task("legacy-task")],
        projects: [project("legacy-project")],
        taskTombstones: [],
        projectTombstones: [],
      });
    await fs.writeFile(
      path.join(root, "workspace-state.json"),
      JSON.stringify(legacy),
    );
    await storage.write("archive-health.json", [
      {
        id: "health-1",
        projectId: "legacy-project",
        checkedAt: 11,
        taskCount: 1,
        healthyTasks: 1,
        failedTasks: 0,
        missingCopies: 0,
        notes: [],
      },
    ]);
    await storage.write("archive-changes.json", [
      {
        id: "change-1",
        projectId: "legacy-project",
        at: 11,
        kind: "verified",
        note: "旧版记录",
      },
    ]);
    await storage.write("archive-reminders.json", [
      {
        id: "reminder-1",
        projectId: "legacy-project",
        intervalDays: 180,
        nextAt: 100,
        enabled: true,
      },
    ]);

    const upgraded = await new WorkspaceRepository(
      storage,
      catalog,
    ).initialize();
    expect(upgraded.state.schemaVersion).toBe(2);
    expect(upgraded.state.revision).toBe(8);
    expect(upgraded.state.archiveEvidence?.healthRecords).toHaveLength(1);
    expect(upgraded.state.archiveEvidence?.changes[0]).toMatchObject({
      operator: "旧版本未记录",
      outcome: "completed",
    });
    expect(upgraded.state.archiveEvidence?.reminders).toHaveLength(1);

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.revision).toBe(8);
    expect(reopened.state.archiveEvidence?.digest).toBe(
      upgraded.state.archiveEvidence?.digest,
    );
  });

  it("migrates authoritative legacy JSON once without reviving extra catalog rows", async () => {
    const { root, storage, catalog } = await fixture();
    await storage.write("tasks.json", [task("json-new", 20)]);
    await storage.write("projects.json", [project("json-project")]);
    await catalog.rebuild(
      [task("catalog-only", 10)],
      [project("catalog-project")],
    );

    const first = await new WorkspaceRepository(storage, catalog).initialize();
    expect(first.source).toBe("legacy");
    expect(first.state.revision).toBe(1);
    expect(first.state.tasks.map((item) => item.id)).toEqual(["json-new"]);
    expect(first.state.projects.map((item) => item.id)).toEqual([
      "json-project",
    ]);
    validateWorkspaceState(
      JSON.parse(
        await fs.readFile(path.join(root, "workspace-state.json"), "utf8"),
      ),
    );

    const second = await new WorkspaceRepository(
      storage,
      new CatalogDatabase(root),
    ).initialize();
    expect(second.source).toBe("primary");
    expect(second.state.revision).toBe(1);
    expect(second.state.migration).toEqual(first.state.migration);
  });

  it("uses a valid catalog only when the corresponding legacy JSON mirror is absent", async () => {
    const { storage, catalog } = await fixture();
    await catalog.rebuild([task("catalog-task")], [project("catalog-project")]);
    const loaded = await new WorkspaceRepository(storage, catalog).initialize();
    expect(loaded.state.tasks.map((item) => item.id)).toEqual(["catalog-task"]);
    expect(loaded.state.projects.map((item) => item.id)).toEqual([
      "catalog-project",
    ]);
  });

  it("treats an explicit empty legacy JSON array as authoritative", async () => {
    const { storage, catalog } = await fixture();
    await storage.write("tasks.json", []);
    await storage.write("projects.json", []);
    await catalog.rebuild([task("stale")], [project("stale")]);
    const loaded = await new WorkspaceRepository(storage, catalog).initialize();
    expect(loaded.state.tasks).toEqual([]);
    expect(loaded.state.projects).toEqual([]);
    expect(await catalog.loadTasks()).toEqual([]);
  });

  it("serializes concurrent task and project commits without losing either domain", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await Promise.all([
      workspace.commitTasks([task("task-a")]),
      workspace.commitProjects([project("project-a")]),
    ]);
    expect(workspace.getTasks().map((item) => item.id)).toEqual(["task-a"]);
    expect(workspace.getProjects().map((item) => item.id)).toEqual([
      "project-a",
    ]);
    expect(workspace.snapshot.revision).toBe(3);
  });

  it("does not resurrect a deleted record when the SQLite index is restored to an older revision", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [task("keep"), task("delete-me")],
      projects: [project("project")],
      syncCatalog: true,
    });
    const oldCatalog = await fs.readFile(path.join(root, "catalog.sqlite"));
    await workspace.commit({ tasks: [task("keep")], syncCatalog: true });
    await fs.writeFile(path.join(root, "catalog.sqlite"), oldCatalog);

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.tasks.map((item) => item.id)).toEqual(["keep"]);
    expect(reopened.state.taskTombstones.map((item) => item.id)).toContain(
      "delete-me",
    );
    expect(
      (await new CatalogDatabase(root).loadTasks()).map((item) => item.id),
    ).toEqual(["keep"]);
  });

  it("atomically applies explicitly confirmed workstation tombstones", async () => {
    const { root, storage, catalog } = await fixture(),
      workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [task("keep")],
      projects: [project("keep-project")],
      syncCatalog: true,
    });
    const committed = await workspace.commit({
      tasks: [task("keep")],
      projects: [project("keep-project")],
      taskTombstones: [
        { id: "remote-deleted-task", deletedAt: 20, revision: 99 },
      ],
      projectTombstones: [
        { id: "remote-deleted-project", deletedAt: 21, revision: 88 },
      ],
      syncCatalog: true,
    });
    expect(committed.state.taskTombstones).toEqual([
      {
        id: "remote-deleted-task",
        deletedAt: 20,
        revision: committed.state.revision,
      },
    ]);
    expect(committed.state.projectTombstones[0]).toMatchObject({
      id: "remote-deleted-project",
      revision: committed.state.revision,
    });
    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.taskTombstones.map((item) => item.id)).toEqual([
      "remote-deleted-task",
    ]);
    expect(reopened.state.projectTombstones.map((item) => item.id)).toEqual([
      "remote-deleted-project",
    ]);
    const unchangedRevision = reopened.state.taskTombstones[0].revision,
      withAnotherDeletion = new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      );
    await withAnotherDeletion.initialize();
    const next = await withAnotherDeletion.commit({
      taskTombstones: [
        reopened.state.taskTombstones[0],
        { id: "another-remote-task", deletedAt: 22, revision: 100 },
      ],
      projectTombstones: reopened.state.projectTombstones,
    });
    expect(
      next.state.taskTombstones.find(
        (item) => item.id === "remote-deleted-task",
      )?.revision,
    ).toBe(unchangedRevision);
    expect(
      next.state.taskTombstones.find(
        (item) => item.id === "another-remote-task",
      )?.revision,
    ).toBe(next.state.revision);
  });

  it("recovers the newest complete catalog snapshot when the primary state is corrupt", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("newest")], syncCatalog: true });
    await fs.writeFile(path.join(root, "workspace-state.json"), "{broken");

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.source).toBe("catalog");
    expect(reopened.state.tasks.map((item) => item.id)).toEqual(["newest"]);
    validateWorkspaceState(
      JSON.parse(
        await fs.readFile(path.join(root, "workspace-state.json"), "utf8"),
      ),
    );
  });

  it("detects unsupported legacy writes instead of guessing how to merge them", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("canonical")], syncCatalog: true });
    await storage.write("tasks.json", [task("legacy-change")]);

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("旧版本或外部程序");
  });

  it("does not choose between two valid but divergent snapshots at the same revision", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("primary")], syncCatalog: true });
    const primary = JSON.parse(
      await fs.readFile(path.join(root, "workspace-state.json"), "utf8"),
    );
    primary.tasks = [task("other-valid")];
    const { digest: _digest, ...body } = primary;
    const conflicting = sealWorkspaceState(body);
    await fs.writeFile(
      path.join(root, "workspace-state.json.bak"),
      JSON.stringify(conflicting),
    );

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("多个互相冲突");
  });

  it("does not overwrite a compatibility mirror that records a newer revision", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("older")], syncCatalog: false });
    await workspace.commit({ tasks: [task("newer")], syncCatalog: false });
    await fs.writeFile(path.join(root, "workspace-state.json"), "{broken");

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("兼容镜像记录的修订高于");
  });

  it("keeps the authoritative commit when index synchronization is interrupted", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const original = catalog.applyWorkspaceState.bind(catalog);
    let fail = true;
    catalog.applyWorkspaceState = async (state) => {
      if (fail) {
        fail = false;
        throw new Error("injected index interruption");
      }
      return original(state);
    };
    const committed = await workspace.commit({
      tasks: [task("committed-before-index")],
      syncCatalog: true,
    });
    expect(committed.indexSynchronized).toBe(false);
    expect(committed.indexError).toContain("injected index interruption");

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.tasks.map((item) => item.id)).toEqual([
      "committed-before-index",
    ]);
    expect(
      (await new CatalogDatabase(root).loadTasks()).map((item) => item.id),
    ).toEqual(["committed-before-index"]);
  });

  it("retries compatibility mirrors after an interruption without advancing the revision", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const original = storage.write.bind(storage);
    let fail = true;
    storage.write = ((name: string, value: unknown) => {
      if (fail && name === "tasks.json") {
        fail = false;
        return Promise.reject(new Error("injected mirror interruption"));
      }
      return original(name, value);
    }) as Storage["write"];
    const committed = await workspace.commitTasks([task("canonical")]);
    expect(committed.compatibilitySynchronized).toBe(false);
    const retried = await workspace.commitTasks([task("canonical")]);
    expect(retried.state.revision).toBe(committed.state.revision);
    expect(retried.compatibilitySynchronized).toBe(true);
    expect(await storage.read<BackupTask[]>("tasks.json", [])).toHaveLength(1);
  });

  it("keeps an authoritative archive evidence commit when an archive mirror write fails", async () => {
    const { root, storage, catalog } = await fixture(),
      workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const evidence = updateArchiveEvidence(
        workspace.getArchiveEvidence(),
        {
          changes: [
            {
              id: "archive-authority-change",
              projectId: "project-a",
              operator: "DIT 测试员",
              at: 20,
              kind: "verified",
              outcome: "completed",
              note: "权威提交",
            },
          ],
        },
        20,
      ),
      original = storage.write.bind(storage);
    let fail = true;
    storage.write = ((name: string, value: unknown) => {
      if (fail && name === "archive-changes.json") {
        fail = false;
        return Promise.reject(
          new Error("injected archive mirror interruption"),
        );
      }
      return original(name, value);
    }) as Storage["write"];
    const committed = await workspace.commitArchiveEvidence(evidence);
    expect(committed.compatibilitySynchronized).toBe(false);
    expect(workspace.getArchiveEvidence().changes).toHaveLength(1);

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.archiveEvidence?.changes[0].id).toBe(
      "archive-authority-change",
    );
  });

  it("can defer the legacy mirror while keeping each active checkpoint authoritative", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const committed = await workspace.commitTasks(
      [task("active-checkpoint")],
      false,
      false,
    );
    expect(committed.compatibilitySynchronized).toBe(false);
    expect(workspace.snapshot.tasks[0].id).toBe("active-checkpoint");
    expect(await storage.read<BackupTask[]>("tasks.json", [])).toEqual([]);

    const synchronized = await workspace.commitTasks([
      task("active-checkpoint"),
    ]);
    expect(synchronized.state.revision).toBe(committed.state.revision);
    expect(synchronized.compatibilitySynchronized).toBe(true);
    expect(await storage.read<BackupTask[]>("tasks.json", [])).toHaveLength(1);
  });

  it("does not publish an in-memory revision when the canonical write fails", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const before = workspace.snapshot,
      original = storage.writeSerialized.bind(storage);
    storage.writeSerialized = ((name: string, value: string) => {
      if (name === "workspace-state.json")
        return Promise.reject(new Error("injected authority interruption"));
      return original(name, value);
    }) as Storage["writeSerialized"];
    await expect(
      workspace.commitTasks([task("not-committed")]),
    ).rejects.toThrow("injected authority interruption");
    expect(workspace.snapshot.revision).toBe(before.revision);
    expect(workspace.snapshot.tasks).toEqual(before.tasks);
  });

  it("removes catalog drift even when its stored workspace metadata still matches", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("canonical")], syncCatalog: true });
    await catalog.upsertTask(task("ghost"));

    await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(
      (await new CatalogDatabase(root).loadTasks()).map((item) => item.id),
    ).toEqual(["canonical"]);
  });

  it("repairs same-count file-row drift instead of trusting index metadata", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [taskWithFiles("canonical-media", ["A.mov", "B.mov"])],
      projects: [{ ...project("project-files"), id: "project-files" }],
      syncCatalog: true,
    });
    const db = await catalog.open();
    db.run(
      "UPDATE files SET relative_path='DCIM/TAMPERED.mov',size=999 WHERE task_id='canonical-media' AND relative_path='DCIM/A.mov'",
    );
    await catalog.flush();

    await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    const repaired = await new CatalogDatabase(root).pageFiles({
      projectId: "project-files",
      limit: 10,
    });
    expect(repaired.map((file) => file.relativePath)).toEqual([
      "DCIM/A.mov",
      "DCIM/B.mov",
    ]);
    expect(repaired.map((file) => file.size)).toEqual([1, 2]);
  });

  it("does not rewrite a clean matching catalog during startup", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [taskWithFiles("clean-media", ["A.mov", "B.mov"])],
      projects: [{ ...project("project-files"), id: "project-files" }],
      syncCatalog: true,
    });
    const file = path.join(root, "catalog.sqlite"),
      fixed = new Date(1_700_000_000_000);
    await fs.utimes(file, fixed, fixed);
    const before = (await fs.stat(file)).mtimeMs;

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.indexRebuilt).toBe(false);
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });

  it("reconciles file rows when a committed task changes and when it is removed", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [taskWithFiles("media", ["A.mov", "B.mov"])],
      projects: [{ ...project("project-files"), id: "project-files" }],
      syncCatalog: true,
    });
    expect((await catalog.stats()).files).toBe(2);
    expect(
      (await catalog.pageFiles({ projectId: "project-files", limit: 10 })).map(
        (file) => file.relativePath,
      ),
    ).toEqual(["DCIM/A.mov", "DCIM/B.mov"]);

    await workspace.commit({
      tasks: [taskWithFiles("media", ["C.mov"])],
      syncCatalog: true,
    });
    expect((await catalog.stats()).files).toBe(1);
    expect(
      (await catalog.pageFiles({ projectId: "project-files", limit: 10 })).map(
        (file) => file.relativePath,
      ),
    ).toEqual(["DCIM/C.mov"]);

    await workspace.commit({ tasks: [], syncCatalog: true });
    expect(await catalog.stats()).toMatchObject({ tasks: 0, files: 0 });
  });

  it("keeps task and project tombstones through index rebuilds", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [task("deleted-task")],
      projects: [project("deleted-project")],
      syncCatalog: true,
    });
    await workspace.commit({ tasks: [], projects: [], syncCatalog: true });
    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.taskTombstones.map((item) => item.id)).toEqual([
      "deleted-task",
    ]);
    expect(reopened.state.projectTombstones.map((item) => item.id)).toEqual([
      "deleted-project",
    ]);
    expect(await new CatalogDatabase(root).loadTasks()).toEqual([]);
    expect(await new CatalogDatabase(root).loadProjects()).toEqual([]);
  });

  it("does not advance a revision for an identical checkpoint", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const first = await workspace.commitTasks([task("same")]);
    const second = await workspace.commitTasks([task("same")]);
    expect(second.state.revision).toBe(first.state.revision);
  });

  it("keeps committed snapshots isolated from later engine and UI mutations", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const mutableTask = task("mutable", 1),
      mutableProject = project("mutable-project");
    await workspace.commit({
      tasks: [mutableTask],
      projects: [mutableProject],
    });
    mutableTask.lastCheckpointAt = 2;
    mutableProject.name = "changed outside";
    const read = workspace.getProjects();
    read[0].name = "changed through getter";
    expect(workspace.snapshot.tasks[0].lastCheckpointAt).toBe(1);
    expect(workspace.snapshot.projects[0].name).toBe("mutable-project");
    const updated = await workspace.commitTasks([mutableTask]);
    expect(updated.state.tasks[0].lastCheckpointAt).toBe(2);
  });

  it("refuses an unknown newer workspace schema instead of falling back to legacy mirrors", async () => {
    const { root, storage, catalog } = await fixture();
    await storage.write("workspace-state.json", {
      schemaVersion: 99,
      revision: 99,
      committedAt: 1,
      tasks: [],
      projects: [],
      taskTombstones: [],
      projectTombstones: [],
      digest: "0".repeat(64),
    });
    await expect(
      new WorkspaceRepository(new Storage(root), catalog).initialize(),
    ).rejects.toThrow("不支持工作区格式版本 99");
  });

  it("refuses to reset revisions from legacy mirrors after every authority copy is corrupt", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("protected")], syncCatalog: true });
    await fs.writeFile(path.join(root, "workspace-state.json"), "{broken");
    await fs.writeFile(path.join(root, "workspace-state.json.bak"), "{broken");
    const db = await catalog.open();
    db.run("UPDATE workspace_state SET json='{broken' WHERE id=1");
    await catalog.flush();
    for (const suffix of [".bak", ".bak2", ".bak3"])
      await fs.writeFile(path.join(root, `catalog.sqlite${suffix}`), "broken");

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("停止启动以避免从旧镜像猜测恢复");
  });

  it("treats a corrupt compatibility marker as evidence of a prior migration", async () => {
    const { root, storage, catalog } = await fixture();
    await storage.write("tasks.json", [task("legacy-mirror")]);
    await storage.write("projects.json", []);
    await fs.writeFile(
      path.join(root, "workspace-compatibility.json"),
      "{broken",
    );

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("停止启动以避免从旧镜像猜测恢复");
  });
});
