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
  type ProjectDirectoryCleanupJournal,
} from "../src/main/project-directory-cleanup";
import {
  assertProjectDirectoryCleanupJournalIdle,
  clearProjectDirectoryCleanupJournal,
  readProjectDirectoryCleanupJournal,
  reconcileProjectDirectoryCleanupJournal,
  withProjectDirectoryCleanupMutation,
  writeProjectDirectoryCleanupJournal,
} from "../src/main/project-directory-cleanup-journal";
import { Storage } from "../src/main/storage";
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
  executeCleanup(
    args[0],
    args[1],
    args[2],
    args[3],
    {
      workstationId,
      ...(args[4] || {}),
    },
    args[5] || {
      beforeMutation: async () => {},
      checkpoint: async () => {},
    },
  );
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

  it("keeps a target whose cleanup authorization was revoked after preview", async () => {
    const { project, date, target } = await fixture(),
      preview = await previewProjectDirectoryCleanup(project, [], {
        date,
        scheduleKey: "FX3",
      });
    expect(preview.targets[0].status).toBe("eligible");
    project.unusedDevicesByDate = {};
    const result = await executeProjectDirectoryCleanup(
      project,
      [],
      preview,
      "DIT",
    );
    expect(result.audit.targets[0]).toMatchObject({ result: "skipped" });
    expect(result.audit.targets[0].reason).toContain("决定已不存在");
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

  it.each([
    ["omits the shooting date", "{project}/{device}/{card}"],
    ["omits the device", "{project}/{shootingDate}/{card}"],
    ["places card before its date and device", "{project}/{card}/{shootingDate}/{device}"],
  ])("keeps a shared custom-rule framework that %s", async (_case, namingRule) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-shared-framework-")),
      destination = path.join(root, "MASTER"),
      date = "2026-09-19";
    roots.push(root);
    await fs.mkdir(destination);
    const project: ProjectConfig = {
      id: `shared-${namingRule}`,
      name: "Shared framework",
      devices: ["FX3", "A7CR"],
      volumePrefix: "CARD_",
      shootingDateStart: date,
      shootingDateEnd: "2026-09-20",
      projectFolderName: "20260919_Shared framework",
      destinationPaths: [destination],
      directoryCreationMode: "precreate",
      namingRule,
      unusedDevicesByDate: { [date]: ["FX3"] },
    };
    await createProjectStructure(project, "explicit-precreate", workstationId);
    const preview = await previewProjectDirectoryCleanup(project, [], {
      date,
      scheduleKey: "FX3",
    });
    expect(preview.targets.length).toBeGreaterThan(0);
    expect(preview.targets.every((target) => target.status === "kept")).toBe(true);
    expect(preview.targets[0].reason).toContain("共同使用");
    expect((await fs.lstat(preview.targets[0].path)).isDirectory()).toBe(true);
  });
});

describe("project empty-directory cleanup recovery journal", () => {
  it("keeps the global journal exclusive across concurrent project cleanups", async () => {
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "kocpy-cleanup-concurrent-"),
      ),
      storage = new Storage(path.join(root, "state")),
      secondTarget = path.join(root, "project-b-empty"),
      first: ProjectDirectoryCleanupJournal = {
        schemaVersion: 1,
        id: "journal-project-a-concurrent",
        auditId: "audit-project-a-concurrent",
        previewId: "preview-project-a-concurrent",
        projectId: "project-a",
        workstationId,
        date: "2026-09-19",
        scheduleKey: "FX3",
        operator: "DIT A",
        requestedAt: 1_000,
        startedAt: 1_100,
        targets: [],
      },
      second: ProjectDirectoryCleanupJournal = {
        ...first,
        id: "journal-project-b-concurrent",
        auditId: "audit-project-b-concurrent",
        previewId: "preview-project-b-concurrent",
        projectId: "project-b",
        operator: "DIT B",
      };
    roots.push(root);
    await fs.mkdir(secondTarget);

    let releaseFirst!: () => void,
      firstStarted!: () => void,
      secondEnteredMutation = false;
    const firstPaused = new Promise<void>((resolve) => {
        firstStarted = resolve;
      }),
      allowFirstToFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
      firstRun = withProjectDirectoryCleanupMutation(async () => {
        await writeProjectDirectoryCleanupJournal(storage, first);
        firstStarted();
        await allowFirstToFinish;
        await clearProjectDirectoryCleanupJournal(storage);
      });

    await firstPaused;
    const secondRun = withProjectDirectoryCleanupMutation(async () => {
      secondEnteredMutation = true;
      await writeProjectDirectoryCleanupJournal(storage, second);
      await fs.rmdir(secondTarget);
      await clearProjectDirectoryCleanupJournal(storage);
    });
    await expect(secondRun).rejects.toThrow(/另一个项目.*正在执行/);
    expect(secondEnteredMutation).toBe(false);
    expect(await readProjectDirectoryCleanupJournal(storage)).toEqual(first);
    expect((await fs.lstat(secondTarget)).isDirectory()).toBe(true);

    releaseFirst();
    await firstRun;
    expect(await readProjectDirectoryCleanupJournal(storage)).toBeUndefined();
    expect((await fs.lstat(secondTarget)).isDirectory()).toBe(true);
  });

  it("globally blocks another project from replacing a pending cleanup journal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-cleanup-lock-")),
      storage = new Storage(path.join(root, "state")),
      first: ProjectDirectoryCleanupJournal = {
        schemaVersion: 1,
        id: "journal-project-a",
        auditId: "audit-project-a",
        previewId: "preview-project-a",
        projectId: "project-a",
        workstationId,
        date: "2026-09-19",
        scheduleKey: "FX3",
        operator: "DIT A",
        requestedAt: 1_000,
        startedAt: 1_100,
        targets: [],
      },
      second: ProjectDirectoryCleanupJournal = {
        ...first,
        id: "journal-project-b",
        auditId: "audit-project-b",
        previewId: "preview-project-b",
        projectId: "project-b",
        operator: "DIT B",
      };
    roots.push(root);
    await writeProjectDirectoryCleanupJournal(storage, first);

    const pending = await readProjectDirectoryCleanupJournal(storage);
    expect(() =>
      assertProjectDirectoryCleanupJournalIdle(
        pending,
        undefined,
        second.projectId,
        "global",
      ),
    ).toThrow(/另一个项目.*恢复记录/);

    // This mirrors the IPC gate: the rejected second operation never reaches
    // its journal write, so project A remains the sole durable authority.
    await expect(
      (async () => {
        assertProjectDirectoryCleanupJournalIdle(
          pending,
          undefined,
          second.projectId,
          "global",
        );
        await writeProjectDirectoryCleanupJournal(storage, second);
      })(),
    ).rejects.toThrow(/另一个项目.*恢复记录/);
    expect(await readProjectDirectoryCleanupJournal(storage)).toEqual(first);
  });

  it("refuses to remove an authorized directory without a durable journal", async () => {
    const { project, date, target } = await fixture(),
      preview = await previewProjectDirectoryCleanup(project, [], {
        date,
        scheduleKey: "FX3",
      });
    await expect(
      executeCleanup(project, [], preview, "DIT", { workstationId }),
    ).rejects.toThrow("持久化恢复日志");
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
  });

  it("recovers a checkpointed removal after project persistence fails", async () => {
    const { root, project, date, target } = await fixture(),
      storage = new Storage(path.join(root, "state")),
      preview = await previewProjectDirectoryCleanup(project, [], {
        date,
        scheduleKey: "FX3",
      }),
      result = await executeCleanup(
        project,
        [],
        preview,
        "DIT",
        { workstationId },
        {
          beforeMutation: (journal) =>
            writeProjectDirectoryCleanupJournal(storage, journal),
          checkpoint: (journal) =>
            writeProjectDirectoryCleanupJournal(storage, journal),
        },
      );
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.audit.targets[0].result).toBe("removed");

    // Simulate writeProjects failing: after restart only the original project
    // and the durable cleanup journal are available.
    const persistProject = async (_value: ProjectConfig) => {
      throw new Error("simulated project persistence failure");
    };
    await expect(persistProject(result.project)).rejects.toThrow(
      "simulated project persistence failure",
    );
    const journal = await readProjectDirectoryCleanupJournal(storage);
    expect(journal?.targets[0].result).toBe("removed");
    const recovered = await reconcileProjectDirectoryCleanupJournal(
      [project],
      journal!,
      2_000,
    );
    expect(recovered.audit.targets[0].result).toBe("removed");
    expect(
      recovered.projects[0].managedProjectDirectories?.[0].removedAt,
    ).toBeTypeOf("number");
    expect(recovered.projects[0].directoryCleanupAudits).toHaveLength(1);

    await storage.write("projects.test.json", recovered.projects);
    await clearProjectDirectoryCleanupJournal(storage);
    expect(await readProjectDirectoryCleanupJournal(storage)).toBeUndefined();
  });

  it("records an uncheckpointed missing path honestly and recovery is idempotent", async () => {
    const { root, project, date, target } = await fixture(),
      storage = new Storage(path.join(root, "state")),
      preview = await previewProjectDirectoryCleanup(project, [], {
        date,
        scheduleKey: "FX3",
      });
    await expect(
      executeCleanup(
        project,
        [],
        preview,
        "DIT",
        { workstationId },
        {
          beforeMutation: (journal) =>
            writeProjectDirectoryCleanupJournal(storage, journal),
          checkpoint: async () => {
            throw new Error("simulated durable checkpoint failure");
          },
        },
      ),
    ).rejects.toThrow("simulated durable checkpoint failure");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });

    const journal = await readProjectDirectoryCleanupJournal(storage);
    expect(journal?.targets[0].result).toBe("pending");
    const first = await reconcileProjectDirectoryCleanupJournal(
      [project],
      journal!,
      3_000,
    );
    expect(first.audit.targets[0].result).toBe("missing-unconfirmed");
    expect(
      first.projects[0].managedProjectDirectories?.[0].removedAt,
    ).toBeUndefined();
    expect(
      first.projects[0].managedProjectDirectories?.[0].missingObservedAt,
    ).toBe(3_000);

    const second = await reconcileProjectDirectoryCleanupJournal(
      first.projects,
      journal!,
      4_000,
    );
    expect(second).toMatchObject({ changed: false, alreadyApplied: true });
    expect(second.projects[0].directoryCleanupAudits).toHaveLength(1);
  });

  it("never removes or blesses a journal target without authorization", async () => {
    const { project, target, destination, relative, date } = await fixture(),
      proof = project.managedProjectDirectories?.[0];
    expect(proof).toBeTruthy();
    const journal: ProjectDirectoryCleanupJournal = {
      schemaVersion: 1,
      id: "journal-unauthorized",
      auditId: "audit-unauthorized",
      previewId: "preview-unauthorized",
      projectId: project.id,
      workstationId,
      date,
      scheduleKey: "FX3",
      operator: "DIT",
      requestedAt: 1_000,
      startedAt: 1_100,
      targets: [
        {
          destinationRoot: destination,
          relativePath: relative,
          path: target,
          proofId: proof!.id,
          authorized: false,
          authorizationReason: "policy changed",
          result: "removed",
          resultReason: "untrusted claim",
          checkedAt: 1_200,
        },
      ],
    };
    const recovered = await reconcileProjectDirectoryCleanupJournal(
      [project],
      journal,
      5_000,
    );
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
    expect(recovered.audit.targets[0].result).toBe("skipped");
    expect(
      recovered.projects[0].managedProjectDirectories?.[0].removedAt,
    ).toBeUndefined();
  });
});
