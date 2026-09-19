import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectStructure,
  expectedProjectPaths,
  inspectProjectStructure,
  repairProjectStructure,
} from "../src/main/project-path";
import {
  executeProjectDirectoryCleanup as executeCleanup,
  previewProjectDirectoryCleanup as previewCleanup,
} from "../src/main/project-directory-cleanup";
import type { BackupTask, ProjectConfig } from "../src/main/types";

const roots: string[] = [];
const workstationId = "11111111-1111-4111-8111-111111111111";
const previewProjectDirectoryCleanup = (
  ...args: Parameters<typeof previewCleanup>
) =>
  previewCleanup(args[0], args[1], args[2], {
    workstationId,
    ...(args[3] || {}),
  });
const executeProjectDirectoryCleanup = (
  ...args: Parameters<typeof executeCleanup>
) =>
  executeCleanup(args[0], args[1], args[2], args[3], {
    workstationId,
    ...(args[4] || {}),
  });
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture(options: { create?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-empty-policy-")),
    destination = path.join(root, "MASTER"),
    date = "2026-09-19";
  roots.push(root);
  await fs.mkdir(destination);
  const project: ProjectConfig = {
    id: "project-empty-policy",
    name: "Empty policy",
    devices: ["FX3"],
    volumePrefix: "FX3_",
    shootingDateStart: date,
    shootingDateEnd: date,
    projectFolderName: "20260919_Empty policy",
    destinationPaths: [destination],
    directoryCreationMode: "precreate",
    unusedDevicesByDate: { [date]: ["FX3"] },
  };
  const relative = expectedProjectPaths(project)[0],
    target = path.join(destination, relative);
  if (options.create !== false)
    await createProjectStructure(project, "explicit-precreate", workstationId);
  return { root, destination, date, project, relative, target };
}

describe("project empty framework directory policy", () => {
  it("removes only an evidenced empty leaf and remembers not to repair it", async () => {
    const { project, date, target } = await fixture();
    const preview = await previewProjectDirectoryCleanup(project, [], {
      date,
      scheduleKey: "FX3",
    });
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0]).toMatchObject({ status: "eligible", path: target });

    const result = await executeProjectDirectoryCleanup(
      project,
      [],
      preview,
      "DIT",
    );
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.audit.targets[0].result).toBe("removed");
    expect(result.project.managedProjectDirectories?.[0].removedAt).toBeTypeOf(
      "number",
    );
    expect((await inspectProjectStructure(result.project)).missingCount).toBe(0);
    await repairProjectStructure(result.project, workstationId);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([".hidden", "zero-byte.txt", ".kocpy-task.partial"])(
    "keeps a directory containing %s",
    async (name) => {
      const { project, date, target } = await fixture();
      await fs.writeFile(path.join(target, name), "");
      const preview = await previewProjectDirectoryCleanup(project, [], {
        date,
        scheduleKey: "FX3",
      });
      expect(preview.targets[0].status).toBe("kept");
      expect(preview.targets[0].reason).toContain("也算内容");
      expect((await fs.lstat(target)).isDirectory()).toBe(true);
    },
  );

  it("rechecks after preview and preserves a file created by a race", async () => {
    const { project, date, target } = await fixture();
    const preview = await previewProjectDirectoryCleanup(project, [], {
      date,
      scheduleKey: "FX3",
    });
    expect(preview.targets[0].status).toBe("eligible");
    await fs.writeFile(path.join(target, "arrived-after-preview.mov"), "");
    const result = await executeProjectDirectoryCleanup(
      project,
      [],
      preview,
      "DIT",
    );
    expect(result.audit.targets[0]).toMatchObject({ result: "skipped" });
    expect(result.audit.targets[0].reason).toContain("也算内容");
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it("rejects a symbolic-link replacement even when its destination is empty", async () => {
    const { project, date, target, root } = await fixture();
    const elsewhere = path.join(root, "elsewhere");
    await fs.mkdir(elsewhere);
    await fs.rmdir(target);
    await fs.symlink(elsewhere, target);
    const preview = await previewProjectDirectoryCleanup(project, [], {
      date,
      scheduleKey: "FX3",
    });
    expect(preview.targets[0]).toMatchObject({ status: "kept" });
    expect(preview.targets[0].reason).toContain("不是普通目录");
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  });

  it("keeps a directory when the destination identity differs", async () => {
    const { project, date, target } = await fixture();
    const preview = await previewProjectDirectoryCleanup(
      project,
      [],
      { date, scheduleKey: "FX3" },
      {
        identity: async () => ({
          id: "different-volume",
          uuid: "22222222-2222-4222-8222-222222222222",
          name: "replacement",
          device: "different-device",
        }),
      },
    );
    expect(preview.targets[0]).toMatchObject({ status: "kept" });
    expect(preview.targets[0].reason).toContain("身份与创建记录不一致");
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it("keeps unknown legacy directories without Kocpy provenance", async () => {
    const { project, date, target } = await fixture({ create: false });
    await fs.mkdir(target, { recursive: true });
    const preview = await previewProjectDirectoryCleanup(project, [], {
      date,
      scheduleKey: "FX3",
    });
    expect(preview.targets[0]).toMatchObject({ status: "kept" });
    expect(preview.targets[0].reason).toContain("没有 Kocpy 创建证明");
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it("does not trust a managed-directory proof imported from another workstation", async () => {
    const { project, date, target } = await fixture();
    const preview = await previewCleanup(
      project,
      [],
      { date, scheduleKey: "FX3" },
      { workstationId: "22222222-2222-4222-8222-222222222222" },
    );
    expect(preview.targets[0]).toMatchObject({ status: "kept" });
    expect(preview.targets[0].reason).toContain("不属于当前工作站");
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it("treats a legacy proof without workstation authority as keep-only", async () => {
    const { project, date, target } = await fixture();
    delete project.managedProjectDirectories?.[0].workstationId;
    const preview = await previewProjectDirectoryCleanup(project, [], {
      date,
      scheduleKey: "FX3",
    });
    expect(preview.targets[0].reason).toContain("旧记录不能授权本机删除");
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it("keeps an empty framework path referenced by a project task", async () => {
    const { project, date, target, destination, relative } = await fixture();
    const task = {
      id: "referencing-task",
      projectId: project.id,
      sourcePath: path.join(path.dirname(destination), "CARD"),
      shootingDateFolder: relative,
      namingTemplate: "FX3_001",
      destinations: [{ id: "d", path: destination }],
    } as BackupTask;
    const preview = await previewProjectDirectoryCleanup(project, [task], {
      date,
      scheduleKey: "FX3",
    });
    expect(preview.targets[0]).toMatchObject({ status: "kept" });
    expect(preview.targets[0].reason).toContain("任务引用");
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });
});
