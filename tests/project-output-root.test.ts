import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import {
  taskOutputRootKey,
  taskOutputRoots,
} from "../src/main/backup/task-output-root";
import { claimProjectTimestampedVolume } from "../src/main/project-path";
import type { BackupTask, TaskConfig } from "../src/main/types";

const projectTask = (
  destination: string,
  overrides: Partial<TaskConfig> = {},
): TaskConfig => ({
  projectId: "project-a",
  projectName: "Project A",
  projectStartDate: "2026-10-15",
  projectFolderName: "20261015_Project A",
  projectNamingRule: "{date}_{project}/{shootingDate}/{card}",
  name: "CARD_202610160030",
  namingTemplate: "CARD_202610160030",
  sourcePath: "/Volumes/CARD",
  destinationPaths: [destination],
  devices: ["FX3"],
  shootingDate: "2026-10-15",
  hashAlgorithm: "sha256",
  ...overrides,
});

describe("project output-root reservations", () => {
  it("does not probe or retain output claims after cancellation", async () => {
    const engine = new BackupEngine(),
      task = engine.createTask(projectTask("/Volumes/OFFLINE")),
      controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      (engine as any).claimTaskOutputRoots(
        task,
        ["/Volumes/OFFLINE"],
        undefined,
        true,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect((engine as any).outputRootClaims.size).toBe(0);
  });

  it("rejects a second logical task before it can enter the engine", () => {
    const engine = new BackupEngine(),
      config = projectTask("/Volumes/MASTER");
    engine.createTask(config);
    expect(() => engine.createTask(config)).toThrow("素材卷目录已被其他任务占用");
    expect(engine.getAllTasks()).toHaveLength(1);
  });

  it("rejects the same absolute root across different projects", () => {
    const engine = new BackupEngine();
    engine.createTask(projectTask("/Volumes/MASTER"));
    expect(() =>
      engine.createTask(
        projectTask("/Volumes/MASTER", { projectId: "project-b" }),
      ),
    ).toThrow("素材卷目录已被其他任务占用");
  });

  it("allows the same relative layout under a different destination root", () => {
    const engine = new BackupEngine();
    engine.createTask(projectTask("/Volumes/MASTER-A"));
    expect(() =>
      engine.createTask(
        projectTask("/Volumes/MASTER-B", { projectId: "project-b" }),
      ),
    ).not.toThrow();
  });

  it.each([
    ["{card}", "{card}/MEDIA"],
    ["{card}/MEDIA", "{card}"],
  ])(
    "rejects ancestor and descendant material roots (%s versus %s)",
    (firstRule, secondRule) => {
      const engine = new BackupEngine();
      engine.createTask(
        projectTask("/Volumes/MASTER", {
          projectFolderName: "Ignored",
          projectNamingRule: firstRule,
          name: "Card",
          namingTemplate: "Card",
        }),
      );
      expect(() =>
        engine.createTask(
          projectTask("/Volumes/MASTER", {
            projectId: "project-b",
            projectFolderName: "Ignored",
            projectNamingRule: secondRule,
            name: "Card",
            namingTemplate: "Card",
          }),
        ),
      ).toThrow("素材卷目录已被其他任务占用");
    },
  );

  it("allows sibling material roots", () => {
    const engine = new BackupEngine();
    engine.createTask(
      projectTask("/Volumes/MASTER", {
        projectFolderName: "Ignored",
        projectNamingRule: "{card}",
        name: "Card-A",
        namingTemplate: "Card-A",
      }),
    );
    expect(() =>
      engine.createTask(
        projectTask("/Volumes/MASTER", {
          projectId: "project-b",
          projectFolderName: "Ignored",
          projectNamingRule: "{card}",
          name: "Card-B",
          namingTemplate: "Card-B",
        }),
      ),
    ).not.toThrow();
  });

  it("compares case and Unicode-composition aliases as one macOS root", () => {
    const engine = new BackupEngine();
    engine.createTask(projectTask("/Volumes/Caf\u00e9"));
    expect(() =>
      engine.createTask(
        projectTask("/volumes/cafe\u0301", { projectId: "project-b" }),
      ),
    ).toThrow("素材卷目录已被其他任务占用");
  });

  it("resolves two aliases asynchronously and rejects the second task before media writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-root-claim-")),
      destination = path.join(root, "destination"),
      alias = path.join(root, "destination-alias"),
      sourceA = path.join(root, "source-a"),
      sourceB = path.join(root, "source-b");
    try {
      await Promise.all(
        [destination, sourceA, sourceB].map((directory) =>
          fs.mkdir(directory, { recursive: true }),
        ),
      );
      await fs.symlink(destination, alias);
      await fs.writeFile(path.join(sourceA, "first.bin"), "first");
      await fs.writeFile(path.join(sourceB, "second.bin"), "second");
      const engine = new BackupEngine(),
        first = engine.createTask(
          projectTask(destination, {
            sourcePath: sourceA,
            projectFolderName: "Ignored",
            projectNamingRule: "{card}",
            name: "Card",
            namingTemplate: "Card",
            automaticPdf: false,
            generateThumbnails: false,
          }),
        ),
        second = engine.createTask(
          projectTask(alias, {
            projectId: "project-b",
            sourcePath: sourceB,
            projectFolderName: "Ignored",
            projectNamingRule: "{card}",
            name: "Card",
            namingTemplate: "Card",
            automaticPdf: false,
            generateThumbnails: false,
          }),
        ),
        settled = (task: BackupTask) =>
          new Promise<BackupTask>((resolve) => {
            const listener = (value: BackupTask) => {
              if (value.id !== task.id) return;
              engine.off("settled", listener);
              resolve(value);
            };
            engine.on("settled", listener);
          }),
        firstSettled = settled(first),
        secondSettled = settled(second);
      // Queue both requests together. The engine serializes media writes; the
      // second task must be stopped by its canonical runtime reservation.
      engine.startTask(first.id);
      engine.startTask(second.id);
      expect((await firstSettled).status).toBe("completed");
      const rejected = await secondSettled;
      expect(rejected.status).toBe("failed");
      expect(rejected.errorMessage).toContain("素材卷目录已被其他任务占用");
      await expect(
        fs.access(path.join(destination, "Card", "second.bin")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("preserves serial ordinary mirror reuse while reserving its active root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mirror-reuse-")),
      source = path.join(root, "source"),
      destination = path.join(root, "destination");
    try {
      await fs.mkdir(source, { recursive: true });
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(source, "clip.bin"), "clip");
      const engine = new BackupEngine(),
        config: TaskConfig = {
          name: "ordinary",
          namingTemplate: "ordinary",
          sourcePath: source,
          destinationPaths: [destination],
          devices: [],
          shootingDate: "",
          hashAlgorithm: "sha256",
          copyMode: "mirror",
          mirrorLayout: "source-folder",
          automaticPdf: false,
          generateThumbnails: false,
        },
        first = engine.createTask(config),
        second = engine.createTask(config),
        settled = (task: BackupTask) =>
          new Promise<BackupTask>((resolve) => {
            const listener = (value: BackupTask) => {
              if (value.id !== task.id) return;
              engine.off("settled", listener);
              resolve(value);
            };
            engine.on("settled", listener);
          }),
        firstSettled = settled(first),
        secondSettled = settled(second);
      engine.startTask(first.id);
      engine.startTask(second.id);
      expect((await firstSettled).status).toBe("completed");
      expect((await secondSettled).status).toBe("completed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("uses an existing resolvedPath as well as its frozen logical root", () => {
    const engine = new BackupEngine(),
      existing = new BackupEngine().createTask(
        projectTask("/Volumes/OLD", { projectId: "old-project" }),
      );
    existing.destinations[0].resolvedPath = path.join(
      "/Volumes/MASTER",
      existing.shootingDateFolder || "",
      existing.namingTemplate,
    );
    engine.loadTask(existing);
    expect(() => engine.createTask(projectTask("/Volumes/MASTER"))).toThrow(
      "素材卷目录已被其他任务占用",
    );
  });

  it("derives ordinary and mirror roots with the same branches used at runtime", () => {
    const candidate = new BackupEngine().createTask(
      projectTask("/Volumes/MASTER"),
    );
    const finalRoot = taskOutputRoots(candidate)[0];
    const ordinary = structuredClone(candidate) as BackupTask;
    ordinary.id = "ordinary";
    ordinary.projectId = undefined;
    ordinary.destinations[0].path = path.dirname(finalRoot);
    ordinary.shootingDateFolder = "";
    ordinary.namingTemplate = path.basename(finalRoot);
    ordinary.copyMode = "normal";
    expect(taskOutputRootKey(taskOutputRoots(ordinary)[0])).toBe(
      taskOutputRootKey(finalRoot),
    );
    const mirror = structuredClone(ordinary);
    mirror.copyMode = "mirror";
    mirror.mirrorLayout = "source-folder";
    expect(taskOutputRootKey(taskOutputRoots(mirror)[0])).toBe(
      taskOutputRootKey(finalRoot),
    );

    const engine = new BackupEngine();
    engine.loadTask(ordinary);
    expect(() => engine.createTask(projectTask("/Volumes/MASTER"))).toThrow(
      "素材卷目录已被其他任务占用",
    );
  });
});

describe("project-wide timestamp claims", () => {
  it("keeps the first label unchanged and increments across devices", () => {
    const timestamp = "202610160030";
    expect(
      claimProjectTimestampedVolume("CARD_", timestamp, {}, {}),
    ).toEqual({ label: "CARD_202610160030", collision: 0 });
    expect(
      claimProjectTimestampedVolume(
        "CARD_",
        timestamp,
        { FX3: timestamp },
        { FX3: 0 },
      ),
    ).toEqual({ label: "CARD_202610160030_02", collision: 1 });
    expect(
      claimProjectTimestampedVolume(
        "CARD_",
        timestamp,
        { FX3: timestamp, A7: timestamp },
        { FX3: 0, A7: 1 },
      ),
    ).toEqual({ label: "CARD_202610160030_03", collision: 2 });
  });

  it("starts a fresh unsuffixed claim in a later minute", () => {
    expect(
      claimProjectTimestampedVolume(
        "CARD_",
        "202610160031",
        { FX3: "202610160030" },
        { FX3: 7 },
      ),
    ).toEqual({ label: "CARD_202610160031", collision: 0 });
  });
});
