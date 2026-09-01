import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalogDatabase } from "../src/main/catalog";
import { sealWorkspaceState } from "../src/main/workspace-contract";

const fixture = () => {
  const fileRecords = [
    {
      name: "a.mov",
      relativePath: "DCIM/a.mov",
      size: 2,
      srcChecksum: "a",
      destinations: [{ verified: true }],
    },
    {
      name: "b.wav",
      relativePath: "AUDIO/b.wav",
      size: 1,
      srcChecksum: "b",
      destinations: [],
    },
  ];
  return {
    task: {
      id: "t",
      projectId: "p",
      name: "CARD01",
      shootingDate: "2026-08-29",
      status: "completed",
      provenance: "kocpy-transfer",
      createdAt: 1,
      totalFiles: 2,
      totalBytes: 3,
      fileRecords,
    } as any,
    project: { id: "p", name: "Film", devices: [], volumePrefix: "" } as any,
  };
};

describe("0.1.16 indexed catalog", () => {
  it("stores task headers separately and reconstructs all file records", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-catalog-"));
    try {
      const db = new CatalogDatabase(root),
        { task, project } = fixture();
      await db.rebuild([task], [project]);
      expect(await db.stats()).toMatchObject({
        tasks: 1,
        files: 2,
        projects: 1,
      });
      expect(
        await db.pageFiles({ projectId: "p", query: "a.mov", limit: 10 }),
      ).toHaveLength(1);
      expect((await db.loadTasks())[0].fileRecords).toEqual(task.fileRecords);
      expect(
        (await fs.stat(path.join(root, "catalog.sqlite"))).size,
      ).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt primary and restores only an integrity-checked backup", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-catalog-recover-"),
    );
    try {
      const { task, project } = fixture(),
        original = new CatalogDatabase(root);
      await original.rebuild([task], [project]);
      await original.upsertTask({ ...task, name: "CARD01-updated" });
      await fs.writeFile(path.join(root, "catalog.sqlite"), "not sqlite");
      const recovered = new CatalogDatabase(root);
      await expect(recovered.open()).rejects.toThrow();
      await recovered.recover();
      expect((await recovered.loadTasks())[0].fileRecords).toHaveLength(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deletes a project's indexed tasks and files as one record operation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-catalog-delete-"),
    );
    try {
      const db = new CatalogDatabase(root),
        { task, project } = fixture(),
        retainedProject = { ...project, id: "retained", name: "Retained" },
        retainedTask = { ...task, id: "retained-task", projectId: "retained" };
      await db.rebuild([task, retainedTask], [project, retainedProject]);
      await db.deleteProjectRecords("p");
      expect(await db.stats()).toMatchObject({
        tasks: 1,
        files: 2,
        projects: 1,
      });
      expect((await db.loadTasks()).map((item) => item.id)).toEqual([
        "retained-task",
      ]);
      expect(await db.pageFiles({ projectId: "p", limit: 10 })).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses stable cursor pagination without duplicates or omissions", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-catalog-page-"),
    );
    try {
      const db = new CatalogDatabase(root),
        project = fixture().project,
        tasks = Array.from({ length: 3 }, (_, taskIndex) => ({
          ...fixture().task,
          id: `task-${taskIndex}`,
          createdAt: 10,
          fileRecords: Array.from({ length: 3 }, (_, fileIndex) => ({
            name: `${taskIndex}-${fileIndex}.mov`,
            relativePath: `DCIM/${taskIndex}-${fileIndex}.mov`,
            size: fileIndex + 1,
            srcChecksum: `${taskIndex}-${fileIndex}`,
            destinations: [],
          })),
          totalFiles: 3,
        }));
      await db.rebuild(tasks as any, [project]);
      const paths: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await db.pageFileBatch({ limit: 2, cursor });
        paths.push(...page.rows.map((row) => String(row.relativePath)));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paths).toHaveLength(9);
      expect(new Set(paths).size).toBe(9);
      expect(paths).toEqual([...paths].sort());

      const first = await db.pageFileBatch({ limit: 2 });
      await expect(
        db.pageFileBatch({ query: "different", cursor: first.nextCursor }),
      ).rejects.toThrow("第一页重新加载");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("restores the previous durable index when publication fails after commit", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-catalog-rollback-"),
    );
    try {
      const db = new CatalogDatabase(root),
        { task, project } = fixture(),
        first = sealWorkspaceState({
          schemaVersion: 1,
          revision: 1,
          committedAt: 1,
          tasks: [task],
          projects: [project],
          taskTombstones: [],
          projectTombstones: [],
        });
      await db.applyWorkspaceState(first);
      const { digest: _digest, ...firstBody } = first;
      const next = sealWorkspaceState({
        ...firstBody,
        revision: 2,
        committedAt: 2,
        tasks: [{ ...task, name: "must-rollback" }],
      });
      const rename = vi.spyOn(fs, "rename");
      rename.mockRejectedValueOnce(
        new Error("injected catalog publication failure"),
      );
      await expect(db.applyWorkspaceState(next)).rejects.toThrow(
        "injected catalog publication failure",
      );
      rename.mockRestore();
      expect((await db.loadTasks())[0].name).toBe(task.name);
      expect((await new CatalogDatabase(root).loadTasks())[0].name).toBe(
        task.name,
      );
    } finally {
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
