import { describe, expect, it, vi } from "vitest";
import { readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizePositions,
  validateArchiveScope,
  validateChecklist,
  submitBatch,
  didComplete,
  readableOperationError,
  type BatchEntry,
} from "../src/common/interaction";
import {
  renderProjectCardPath,
  previewProjectPath,
} from "../src/common/project-layout";
import { expectedProjectPaths } from "../src/main/project-path";
import { OperationRegistry } from "../src/main/operations";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { LanProjectIndex, readLanProjectIndex } from "../src/main/lan-index";
import type { BackupTask } from "../src/main/types";
import {
  dialogControlName,
  isDialogCloseControl,
} from "../src/common/dialog";

describe("explicit scope and human confirmation", () => {
  it("recognizes dialog close controls by explicit metadata and accessible name", () => {
    const element = (attributes: Record<string, string>, text = "") =>
      ({
        textContent: text,
        getAttribute(name: string) {
          return attributes[name] || null;
        },
      }) as unknown as Element;
    expect(dialogControlName(element({ "aria-label": "关闭差异窗口" }))).toBe(
      "关闭差异窗口",
    );
    expect(
      isDialogCloseControl(element({ "aria-label": "关闭差异窗口" })),
    ).toBe(true);
    expect(isDialogCloseControl(element({ title: "关闭" }))).toBe(true);
    expect(
      isDialogCloseControl(element({ "data-dialog-close": "true" }, "返回")),
    ).toBe(true);
    expect(isDialogCloseControl(element({}, "删除项目记录"))).toBe(false);
  });
  it.each(["card", "file"] as const)(
    "rejects empty %s instead of widening",
    (kind) => {
      expect(() =>
        validateArchiveScope({
          kind,
          projectId: "p",
          taskId: "",
          relativePath: "clip.mov",
        }),
      ).toThrow("素材卷");
    },
  );
  it("rejects missing project, invalid dates, disk and traversal", () => {
    for (const scope of [
      { kind: "project" },
      { kind: "day", projectId: "p", shootingDate: "" },
      { kind: "disk", volumePath: "relative" },
      { kind: "file", projectId: "p", taskId: "t", relativePath: "../other" },
    ] as any[])
      expect(() => validateArchiveScope(scope)).toThrow();
  });
  it("strips irrelevant stale controls from requests", () => {
    expect(
      validateArchiveScope({
        kind: "project",
        projectId: "p",
        taskId: "old",
        relativePath: "clip",
        shootingDate: "2026-08-31",
        volumePath: "/old",
      }),
    ).toMatchObject({
      projectId: "p",
      taskId: undefined,
      shootingDate: undefined,
      relativePath: undefined,
      volumePath: undefined,
    });
    expect(
      validateArchiveScope({
        kind: "disk",
        volumePath: "/Volumes/Archive",
        projectId: "p",
      }).projectId,
    ).toBeUndefined();
  });
  it("requires actual signature and all mandatory checks, not all optional checks", () => {
    const items = [
      { id: "a", required: true },
      { id: "b", required: false },
    ];
    expect(() => validateChecklist(items, ["a"], "")).toThrow("签署人");
    expect(() => validateChecklist(items, ["b"], "DIT")).toThrow("必填");
    expect(() => validateChecklist([], [], "DIT")).toThrow("检查项");
    expect(validateChecklist(items, ["a", "a", "invented"], "DIT")).toEqual([
      "a",
    ]);
  });
  it("distinguishes cancellation and strips nested IPC prefix", () => {
    expect(didComplete(null)).toBe(false);
    expect(didComplete(false)).toBe(false);
    expect(didComplete({ repaired: 0 })).toBe(true);
    expect(
      readableOperationError(
        new Error(
          "Error invoking remote method 'existing:repair': Error: 缺少素材",
        ),
      ),
    ).toBe("缺少素材");
  });
});

describe("repeatable batch submission", () => {
  it("retries only unresolved creates and never duplicates successful entries", async () => {
    const entries: BatchEntry[] = [
      { sourcePath: "/a", requestId: "1" },
      { sourcePath: "/b", requestId: "2" },
    ];
    let failed = false;
    const create = vi.fn(async (entry: BatchEntry) => {
      entry.claim ||= { label: "stable-" + entry.requestId };
      if (entry.requestId === "2" && !failed) {
        failed = true;
        throw Error("offline");
      }
      return { id: entry.requestId };
    });
    const start = vi.fn(async () => {});
    await expect(submitBatch(entries, create, start, () => {})).rejects.toThrow(
      "offline",
    );
    expect(entries[0]).toMatchObject({ taskId: "1", started: true });
    await submitBatch(entries, create, start, () => {});
    expect(create.mock.calls.map((args) => args[0].requestId)).toEqual([
      "1",
      "2",
      "2",
    ]);
    expect(start.mock.calls).toHaveLength(2);
    expect(entries[1].claim?.label).toBe("stable-2");
  });
  it("retains a created task when its start response fails", async () => {
    const entries: BatchEntry[] = [{ sourcePath: "/a", requestId: "1" }];
    const create = vi.fn(async () => ({ id: "t" }));
    const start = vi
      .fn()
      .mockRejectedValueOnce(Error("response"))
      .mockResolvedValueOnce(true);
    await expect(
      submitBatch(entries, create, start, () => {}),
    ).rejects.toThrow();
    await submitBatch(entries, create, start, () => {});
    expect(create).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("one project path and arbitrary safe positions", () => {
  const values = {
    projectName: "Film",
    projectFolderName: "20260831_Film",
    projectStartDate: "2026-08-31",
    shootingDate: "2026-09-01",
    device: "FX3",
    position: "手持 2",
    card: "Card01",
  };
  it("normalizes without restricting to A–E and rejects traversal", () => {
    expect(normalizePositions(["手持 2", " A ", "手持 2", ""])).toEqual([
      "手持 2",
      "A",
    ]);
    expect(() => normalizePositions(["../A"])).toThrow();
    expect(() => normalizePositions(["1", "2", "3", "4", "5", "6"])).toThrow();
  });
  it("uses exactly the same custom rule in preview, precreation and engine", () => {
    const rule = "{date}_{project}/{device}/{shootingDate}/{position}/{card}";
    expect(previewProjectPath(rule, values)).toBe(
      renderProjectCardPath(rule, values),
    );
    expect(renderProjectCardPath(rule, values)).toBe(
      "20260831_Film/FX3/20260901/手持 2/Card01",
    );
    expect(
      expectedProjectPaths({
        id: "p",
        name: "Film",
        devices: ["FX3"],
        volumePrefix: "C_",
        projectFolderName: "20260831_Film",
        shootingDateStart: "2026-08-31",
        devicePositions: { FX3: ["手持 2"] },
        namingRule: rule,
      }),
    ).toEqual(["20260831_Film/FX3/20260831/手持 2"]);
    expect(previewProjectPath("{unknown}", values)).toContain("规则待修正");
  });
  it("copies and verifies a custom-position task to the previewed path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-interaction-"));
    try {
      const src = path.join(root, "source"),
        dest = path.join(root, "dest");
      await fs.mkdir(src);
      await fs.mkdir(dest);
      await fs.writeFile(path.join(src, "clip.mov"), "footage");
      const engine = new BackupEngine();
      const task = engine.createTask({
        sourcePath: src,
        destinationPaths: [dest],
        name: "Card01",
        namingTemplate: "Card01",
        projectId: "p",
        devices: ["FX3"],
        cameraPosition: "手持 2",
        shootingDate: "2026-09-01",
        projectName: "Film",
        projectStartDate: "2026-08-31",
        projectFolderName: "20260831_Film",
        projectNamingRule:
          "{date}_{project}/{device}/{shootingDate}/{position}/{card}",
        hashAlgorithm: "sha256",
        generateThumbnails: false,
      });
      const done = new Promise<BackupTask>((resolve) =>
        engine.once("settled", resolve),
      );
      engine.startTask(task.id);
      const finished = await done;
      expect(finished.status).toBe("completed");
      let context: unknown;
      engine.once("settled", (_task, reason) => { context=reason; });
      await engine.reverifyTask(task.id);
      expect(context).toEqual({kind:"reverify"});
      expect(finished.destinations[0].resolvedPath).toBe(
        path.join(
          await fs.realpath(dest),
          renderProjectCardPath(
            "{date}_{project}/{device}/{shootingDate}/{position}/{card}",
            values,
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("operation lifetime independent of the modal", () => {
  it("locks parallel jobs, retains progress, then releases on cancellation", async () => {
    const registry = new OperationRegistry();
    let finish!: (value: null) => void;
    const operation = registry.run(
      "hash",
      () => new Promise<null>((resolve) => (finish = resolve)),
    );
    registry.progress({ message: "reading", completedBytes: 10 });
    expect(registry.active).toBe(true);
    expect(registry.list()[0].progress.completedBytes).toBe(10);
    await expect(registry.run("other", async () => true)).rejects.toThrow(
      "已有维护",
    );
    finish(null);
    await operation;
    expect(registry.active).toBe(false);
    expect(registry.list()[0].status).toBe("cancelled");
  });
  it("retains failure context and partial results without green all-clear", async () => {
    const registry = new OperationRegistry();
    await expect(
      registry.run("repair", async () => {
        throw Error("已修复 2，仍缺 1");
      }),
    ).rejects.toThrow();
    expect(registry.list()[0]).toMatchObject({
      status: "failed",
      error: "已修复 2，仍缺 1",
    });
    await registry.run("verify", async () => ({
      taskCount: 3,
      healthyTasks: 2,
      missingCopies: 1,
    }));
    expect(registry.list()[1].result).toContain("2/3");
  });
});

describe("LAN metadata workflow", () => {
  it("reads without command line and does not share crew, paths or notes", async () => {
    const server = new LanProjectIndex(() => ({
      projects: [
        {
          id: "p",
          name: "Film",
          devices: [],
          volumePrefix: "",
          destinationPaths: ["/private"],
          handoffNotes: [
            { id: "n", at: 1, operator: "private", note: "private" },
          ],
          crew: [{ id: "c", name: "private", role: "DIT" }],
        },
      ],
      tasks: [],
    }));
    try {
      const info = await server.start(0);
      const data = await readLanProjectIndex(
        "http://127.0.0.1:" + info.port + "/index",
        info.token,
      );
      expect(data.projects[0]).toMatchObject({ id: "p", name: "Film" });
      expect(JSON.stringify(data)).not.toContain("private");
      await expect(
        readLanProjectIndex(
          "http://127.0.0.1:" + info.port + "/index",
          "wrong",
        ),
      ).rejects.toThrow("令牌");
      await expect(
        readLanProjectIndex("https://example.com/index", info.token),
      ).rejects.toThrow("局域网");
    } finally {
      server.stop();
    }
  });
});

it("regression contracts: no progress-driven catalog fetch, no automatic checklist signing, no blocking completion modal", () => {
  const app = readFileSync("src/renderer/src/App.tsx", "utf8"),
    composer = readFileSync("src/renderer/src/Composer.tsx", "utf8"),
    main = readFileSync("src/main/index.ts", "utf8");
  expect(app).not.toContain("[query, kind, limit, tasks]");
  expect(app).not.toContain(
    'api.addProjectHandoff(select.value, "@sexyfeifan"',
  );
  expect(app).not.toContain('className="completion-modal"');
  expect(app).not.toContain("candidates.slice(0, 12)");
  expect(/submitBatch\(\s*batch\.current/.test(composer)).toBe(true);
  expect(main).not.toContain(
    "const changeChannels = /^(tasks:(create|delete|reverify|retry-failed)|projects:|",
  );
  expect(main).toContain("guardedCommands.has(name)");
});
