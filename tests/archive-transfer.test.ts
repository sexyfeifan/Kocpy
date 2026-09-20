import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  ArchiveTransferManager,
  archiveTransferInternals,
  loadArchiveTransferTasks,
  validateArchiveTransferTasks,
  type ArchiveTransferContext,
  type ArchiveTransferProgress,
  type ArchiveTransferReportSnapshot,
  type ArchiveTransferRenderedReports,
  type ArchiveTransferTask,
} from "../src/main/archive-transfer";
import {
  archiveTransferContractDigest,
  archiveTransferReportContract,
  buildArchiveTransferDetailHtml,
  buildArchiveTransferSummaryHtml,
} from "../src/main/archive-transfer-report";
import { Storage } from "../src/main/storage";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function legacy036Fixture(): Promise<unknown[]> {
  return JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), "tests/fixtures/archive-transfers-0.1.36.json"),
      "utf8",
    ),
  );
}

async function fixture(label = "项目_很长的中文路径_甲") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-archive-transfer-")),
    source = path.join(root, label),
    destinationParent = path.join(root, "已挂载 NAS 父目录");
  roots.push(root);
  await fs.mkdir(path.join(source, "素材", "空目录"), { recursive: true });
  await fs.mkdir(destinationParent);
  await fs.writeFile(path.join(source, "素材", "A001.mov"), Buffer.alloc(9131, 17));
  await fs.writeFile(path.join(source, ".hidden-sidecar"), "hidden-payload");
  await fs.writeFile(path.join(source, "既有报告.pdf"), "original-pdf-payload");
  await fs.writeFile(path.join(source, "历史清单.mhl"), "original-mhl-payload");
  return { root, source, destinationParent };
}

const context: ArchiveTransferContext = {
  projectId: "project-1",
  archiveName: "中文归档项目",
  archiveNameSource: "project",
  shootingDate: "2026-09-19",
  historicalEvidence: ["历史 MHL 仍有 1 项缺失，不因本次转存通过而消失"],
};

function testManager(options?: {
  destinationParent?: string;
  disconnected?: () => boolean;
  destinationUuid?: () => string;
  progress?: (completed: number) => void;
  progressDetail?: (progress: ArchiveTransferProgress) => void;
  report?: (
    snapshot: ArchiveTransferReportSnapshot,
    artifactReportId: string,
  ) => Promise<ArchiveTransferRenderedReports>;
  persist?: (tasks: ArchiveTransferTask[], call: number) => Promise<void>;
  availableBytes?: number;
  randomId?: () => string;
  removeFile?: (file: string) => Promise<void>;
  nowStep?: number;
}) {
  let persisted: ArchiveTransferTask[] = [],
    persistCall = 0;
  const manager = new ArchiveTransferManager({
    identifyVolume: async (location) => {
      const destination = Boolean(
        options?.destinationParent &&
          (location === options.destinationParent ||
            location.startsWith(options.destinationParent + path.sep) ||
            location.includes(`${path.sep}${path.basename(options.destinationParent)}`)),
      );
      if (destination && options?.disconnected?.())
        throw new Error("simulated NAS disconnect");
      return {
        id: destination ? "nas-volume-1" : "source-volume-1",
        uuid: destination
          ? options?.destinationUuid?.() || "NAS-UUID-1"
          : "SOURCE-UUID-1",
        name: destination ? "NAS" : "SOURCE",
        device: destination ? "902" : "901",
        mountPoint: destination ? options!.destinationParent : path.dirname(location),
        fileSystem: destination ? "smbfs" : "apfs",
      };
    },
    availableBytes: async () => options?.availableBytes ?? 1024 ** 4,
    persist: async (tasks) => {
      const snapshot = structuredClone(tasks);
      await options?.persist?.(snapshot, ++persistCall);
      persisted = snapshot;
    },
    renderReports:
      options?.report ||
      (async () => ({ pdf: Buffer.from("pdf"), png: Buffer.from("png") })),
    onProgress: (value) => {
      options?.progress?.(value.completedFiles);
      options?.progressDetail?.(value);
    },
    now: (() => {
      let value = Date.UTC(2026, 8, 19, 10, 0, 0);
      return () => (value += options?.nowStep || 1);
    })(),
    randomId:
      options?.randomId ||
      (() => "12345678-abcd-4000-8000-123456789abc"),
    removeFile: options?.removeFile,
  });
  return { manager, persisted: () => persisted };
}

describe("independent NAS archive transfer", () => {
  it("emits throttled monotonic in-file progress across copy, reread and report phases", async () => {
    const { source, destinationParent } = await fixture("大文件进度项目"),
      largeFile = path.join(source, "素材", "A001.mov"),
      events: ArchiveTransferProgress[] = [];
    await fs.writeFile(largeFile, Buffer.alloc(13 * 1024 * 1024, 23));
    const { manager } = testManager({
        destinationParent,
        nowStep: 300,
        progressDetail: (progress) => events.push(structuredClone(progress)),
      }),
      preview = await manager.preview(source, destinationParent, context);
    await manager.start({
      sourcePath: source,
      destinationParent,
      previewDigest: preview.inventory.digest,
      context,
    });

    const copying = events.filter(
        (event) =>
          event.phase === "copying" &&
          event.currentFile === "素材/A001.mov" &&
          event.currentFileBytes > 0,
      ),
      verifying = events.filter(
        (event) =>
          event.phase === "verifying" &&
          event.currentFile === "素材/A001.mov" &&
          event.currentFileBytes > 0,
      );
    expect(copying.length).toBeGreaterThan(2);
    expect(verifying.length).toBeGreaterThan(2);
    for (const phase of [copying, verifying]) {
      const values = phase.map((event) => event.currentFileBytes);
      expect(values).toEqual([...values].sort((left, right) => left - right));
      expect(values.every((value) => value <= phase[0].currentFileTotalBytes)).toBe(
        true,
      );
      expect(phase.some((event) => event.speedBps > 0)).toBe(true);
    }
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(["copying", "verifying", "reporting", "completed"]),
    );
    const overall = events.map((event) => event.overallProcessedBytes);
    expect(overall).toEqual([...overall].sort((left, right) => left - right));
    expect(events.every((event) => event.overallProcessedBytes <= event.overallTotalBytes)).toBe(true);
    const reporting = events.find((event) => event.phase === "reporting"),
      completed = events.at(-1)!;
    expect(reporting).toMatchObject({ speedBps: 0, etaSeconds: 0 });
    expect(completed).toMatchObject({
      phase: "completed",
      processedBytes: preview.inventory.totalBytes,
      overallProcessedBytes: preview.inventory.totalBytes * 2,
      overallTotalBytes: preview.inventory.totalBytes * 2,
      speedBps: 0,
      etaSeconds: 0,
    });
  });

  it("rejects a same-name network remount even when its device number is reused", () => {
    const base = {
      id: "42",
      device: "42",
      name: "Archive",
      mountPoint: "/Volumes/Archive",
      fileSystem: "smbfs",
      mountSourceDigest: "server-a-share",
    };
    expect(
      archiveTransferInternals.sameIdentity(base, {
        ...base,
        mountSourceDigest: "server-b-share",
      }),
    ).toBe(false);
  });

  it("copies the complete actual folder, independently rereads SHA-256 and keeps reports outside payload totals", async () => {
    const { source, destinationParent } = await fixture(),
      { manager, persisted } = testManager({ destinationParent }),
      preview = await manager.preview(source, destinationParent, context);
    expect(preview.inventory.totalFiles).toBe(4);
    expect(preview.inventory.existingPdfFiles).toBe(1);
    expect(preview.inventory.existingManifestFiles).toBe(1);
    expect(preview.inventory.emptyDirectories).toEqual(["素材/空目录"]);
    expect(preview.evidenceBoundary).toContain("不验证磁盘占用、ACL、扩展属性、权限");

    const task = await manager.start({
      sourcePath: source,
      destinationParent,
      previewDigest: preview.inventory.digest,
      context,
    });
    expect(task.status).toBe("completed");
    expect(task.reportStatus).toBe("completed");
    expect(task.inventory.totalFiles).toBe(4);
    expect(task.completedFiles).toBe(4);
    expect(task.verifiedBytes).toBe(task.inventory.totalBytes);
    expect(task.reportSnapshot).toMatchObject({
      payloadFileCount: 4,
      payloadBytes: task.inventory.totalBytes,
      hashAlgorithm: "SHA-256",
      verificationConclusion: "通过",
      historicalEvidence: context.historicalEvidence,
    });
    expect(task.reportSnapshot!.evidenceBoundary).toContain("时间戳");
    expect(await fs.readFile(path.join(task.finalPath, "既有报告.pdf"), "utf8")).toBe(
      "original-pdf-payload",
    );
    expect(await fs.readFile(path.join(task.finalPath, "历史清单.mhl"), "utf8")).toBe(
      "original-mhl-payload",
    );
    expect(await fs.readFile(path.join(source, "素材", "A001.mov"))).toHaveLength(
      9131,
    );
    expect((await fs.stat(path.join(task.finalPath, "素材", "空目录"))).isDirectory()).toBe(
      true,
    );
    expect(persisted()[0].status).toBe("completed");
    expect(await fs.stat(task.markerPath).then(() => true, () => false)).toBe(false);
    expect(task.reportAttempts[0].artifactReportId).toBe(task.reportId);
    expect(validateArchiveTransferTasks([task])).toEqual([task]);
  });

  it("rejects corrupted persistent transfer records and falls back only to a validated backup", async () => {
    const { root, source, destinationParent } = await fixture("持久记录项目"),
      { manager } = testManager({ destinationParent }),
      preview = await manager.preview(source, destinationParent, context),
      task = await manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      });
    for (const mutate of [
      (value: ArchiveTransferTask) => {
        value.schemaVersion = 99 as 1;
      },
      (value: ArchiveTransferTask) => {
        value.inventory.files[0].relativePath = "../escape.mov";
      },
      (value: ArchiveTransferTask) => {
        value.inventory.totalBytes = -1;
      },
      (value: ArchiveTransferTask) => {
        value.inventory.digest = "0".repeat(64);
      },
      (value: ArchiveTransferTask) => {
        delete value.inventory.files[0].ctimeMs;
      },
      (value: ArchiveTransferTask) => {
        value.finalPath = path.join(root, "outside-owned-target");
      },
    ]) {
      const corrupted = structuredClone(task);
      mutate(corrupted);
      expect(() => validateArchiveTransferTasks([corrupted])).toThrow(
        /归档转存/,
      );
    }

    const state = path.join(root, "state"),
      store = new Storage(state),
      file = path.join(state, "archive-transfers.json");
    await store.write("archive-transfers.json", [task]);
    await store.write("archive-transfers.json", [task]);
    await fs.writeFile(file, JSON.stringify([{ schemaVersion: 99 }]));
    await expect(
      store.readValidated("archive-transfers.json", [], validateArchiveTransferTasks),
    ).resolves.toEqual([task]);
    await fs.writeFile(`${file}.bak`, JSON.stringify([{ schemaVersion: 99 }]));
    await expect(
      store.readValidated("archive-transfers.json", [], validateArchiveTransferTasks),
    ).rejects.toThrow(/主记录与备份均未通过/);
  });

  it("migrates a real 0.1.36 completed record as read-only evidence without inventing ctime", async () => {
    const migratedAt = Date.UTC(2026, 8, 20, 8, 0, 0),
      loaded = loadArchiveTransferTasks(await legacy036Fixture(), migratedAt),
      completed = loaded.tasks[0];
    expect(loaded.migrated).toBe(true);
    expect(completed).toMatchObject({
      schemaVersion: 1,
      status: "completed",
      reportStatus: "completed",
      legacyMigration: {
        sourceVersion: "0.1.36",
        migratedAt,
        originalStatus: "completed",
        originalReportStatus: "completed",
        disposition: "read-only-completed",
      },
    });
    expect(completed.inventory.files.every((file) => file.ctimeMs === undefined)).toBe(
      true,
    );
    expect(completed.inventory.digest).toBe(
      "591bc34148825ed7e8837a91c51a1a30c2b880608513d03444d8b6259f771ae5",
    );
    expect(completed.reportAttempts[0]).not.toHaveProperty("pdfSha256");
    expect(validateArchiveTransferTasks(loaded.tasks)).toEqual(loaded.tasks);

    const { manager } = testManager();
    await manager.initialize(loaded.tasks);
    await expect(manager.retryReports(completed.id)).rejects.toThrow(/只读证据/);
  });

  it("safely terminates a 0.1.36 incomplete task and requires a new preflight", async () => {
    const loaded = loadArchiveTransferTasks(
        await legacy036Fixture(),
        Date.UTC(2026, 8, 20, 8, 1, 0),
      ),
      incomplete = loaded.tasks[1];
    expect(incomplete).toMatchObject({
      status: "failed",
      completedFiles: 1,
      verifiedBytes: 4,
      legacyMigration: {
        originalStatus: "interrupted",
        disposition: "restart-required",
      },
    });
    expect(incomplete.error).toContain("重新选择源与归档目标");
    expect(incomplete.error).toContain("重新预检");
    expect(incomplete.recoveryEvents.at(-1)).toMatchObject({
      action: "legacy-0.1.36-record-migrated-read-only",
    });
    const { manager } = testManager();
    await manager.initialize(loaded.tasks);
    await expect(manager.resume(incomplete.id)).rejects.toThrow(/不能安全恢复.*重新预检/);
  });

  it("rejects tampered 0.1.36 archive state instead of laundering it through migration", async () => {
    const fixture = await legacy036Fixture();
    for (const mutate of [
      (value: any[]) => {
        value[0].inventory.digest = "0".repeat(64);
      },
      (value: any[]) => {
        value[0].inventory.files[0].relativePath = "../escape.mov";
      },
      (value: any[]) => {
        value[0].inventory.files[0].ctimeMs = 123;
      },
      (value: any[]) => {
        delete value[0].reportSnapshot;
      },
      (value: any[]) => {
        value[1].reportStatus = "completed";
      },
    ]) {
      const corrupted = structuredClone(fixture);
      mutate(corrupted);
      expect(() =>
        loadArchiveTransferTasks(corrupted, Date.UTC(2026, 8, 20, 8, 2, 0)),
      ).toThrow(/归档转存/);
    }
    const migrated = loadArchiveTransferTasks(
      fixture,
      Date.UTC(2026, 8, 20, 8, 2, 30),
    ).tasks;
    migrated[0].recoveryEvents.pop();
    expect(() => loadArchiveTransferTasks(migrated)).toThrow(/迁移证据无效/);
  });

  it("persists the legacy migration once and remains idempotent after restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-archive-migrate-")),
      store = new Storage(root),
      statePath = path.join(root, "archive-transfers.json");
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(await legacy036Fixture(), null, 2));

    const first = await store.readValidatedWithSource(
      "archive-transfers.json",
      { tasks: [], migrated: false },
      (value) =>
        loadArchiveTransferTasks(value, Date.UTC(2026, 8, 20, 8, 3, 0)),
    );
    expect(first.source).toBe("primary");
    expect(first.value.migrated).toBe(true);
    await store.write("archive-transfers.json", first.value.tasks);
    const persisted = await fs.readFile(statePath, "utf8"),
      second = await store.readValidatedWithSource(
        "archive-transfers.json",
        { tasks: [], migrated: false },
        (value) =>
          loadArchiveTransferTasks(value, Date.UTC(2026, 8, 20, 9, 0, 0)),
      );
    expect(second.value.migrated).toBe(false);
    expect(second.value.tasks).toEqual(first.value.tasks);
    expect(
      second.value.tasks[0].recoveryEvents.filter(
        (event) => event.action === "legacy-0.1.36-record-migrated-read-only",
      ),
    ).toHaveLength(1);
    expect(await fs.readFile(statePath, "utf8")).toBe(persisted);
  });

  it("migrates a validated legacy backup without replacing it with a corrupt primary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-archive-fallback-")),
      store = new Storage(root),
      statePath = path.join(root, "archive-transfers.json"),
      backupPath = `${statePath}.bak`,
      legacy = JSON.stringify(await legacy036Fixture(), null, 2);
    roots.push(root);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify([{ schemaVersion: 99 }]));
    await fs.writeFile(backupPath, legacy);

    const recovered = await store.readValidatedWithSource(
      "archive-transfers.json",
      { tasks: [], migrated: false },
      (value) =>
        loadArchiveTransferTasks(value, Date.UTC(2026, 8, 20, 8, 4, 0)),
    );
    expect(recovered.source).toBe("backup");
    expect(recovered.value.migrated).toBe(true);
    await store.writeRecovered("archive-transfers.json", recovered.value.tasks);
    expect(await fs.readFile(backupPath, "utf8")).toBe(legacy);
    await expect(
      store.readValidatedWithSource(
        "archive-transfers.json",
        { tasks: [], migrated: false },
        loadArchiveTransferTasks,
      ),
    ).resolves.toMatchObject({
      source: "primary",
      value: { migrated: false },
    });
  });

  it("never overwrites a same-name target and rejects nested or aliased overlap", async () => {
    const { root, source, destinationParent } = await fixture("冲突项目"),
      { manager } = testManager({ destinationParent }),
      target = path.join(destinationParent, path.basename(source));
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "do-not-overwrite"), "existing");
    await expect(manager.preview(source, destinationParent, context)).rejects.toThrow(
      "不会覆盖",
    );
    expect(await fs.readFile(path.join(target, "do-not-overwrite"), "utf8")).toBe(
      "existing",
    );
    const nested = path.join(source, "nested-target");
    await fs.mkdir(nested);
    await expect(manager.preview(source, nested, context)).rejects.toThrow("互相嵌套");
    const alias = path.join(root, "source-alias");
    await fs.symlink(source, alias);
    await expect(manager.preview(alias, nested, context)).rejects.toThrow("互相嵌套");
  });

  it("stops when the source changes after preview and creates no target", async () => {
    const { source, destinationParent } = await fixture("源变化项目"),
      { manager } = testManager({ destinationParent }),
      preview = await manager.preview(source, destinationParent, context);
    await fs.appendFile(path.join(source, "素材", "A001.mov"), "changed");
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("源文件夹内容已变化");
    expect(
      await fs
        .stat(path.join(destinationParent, path.basename(source)))
        .then(() => true, () => false),
    ).toBe(false);
  });

  it("detects a same-size source rewrite even when mtime is restored", async () => {
    const { source, destinationParent } = await fixture("同大小源变化项目"),
      { manager } = testManager({ destinationParent }),
      preview = await manager.preview(source, destinationParent, context),
      sourceFile = path.join(source, "素材", "A001.mov"),
      before = await fs.stat(sourceFile);
    await fs.writeFile(sourceFile, Buffer.alloc(before.size, 99));
    await fs.utimes(sourceFile, before.atime, before.mtime);
    expect((await fs.stat(sourceFile)).size).toBe(before.size);
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("源文件夹内容已变化");
    expect(
      await fs
        .stat(path.join(destinationParent, path.basename(source)))
        .then(() => true, () => false),
    ).toBe(false);
  });

  it("detects a source mutation during copying and never certifies the stale snapshot", async () => {
    const { source, destinationParent } = await fixture("传输中变化项目");
    let mutated = false;
    const { manager, persisted } = testManager({
      destinationParent,
      progress: (completed) => {
        if (completed === 1 && !mutated) {
          mutated = true;
          appendFileSync(
            path.join(source, "素材", "A001.mov"),
            "source-mutated-during-transfer",
          );
        }
      },
    });
    const preview = await manager.preview(source, destinationParent, context);
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("源文件夹内容已变化");
    expect(persisted()[0].status).toBe("interrupted");
    expect(persisted()[0].reportSnapshot).toBeUndefined();
  });

  it("stops on simulated NAS disconnect, checks the original volume identity, and resumes idempotently", async () => {
    const { source, destinationParent } = await fixture("断线恢复项目"),
      second = path.join(source, "素材", "B002.mov");
    await fs.writeFile(second, Buffer.alloc(2048, 44));
    let disconnected = false,
      didDisconnect = false,
      replacementMounted = false;
    const { manager, persisted } = testManager({
      destinationParent,
      disconnected: () => disconnected,
      destinationUuid: () =>
        replacementMounted ? "SAME-NAME-DIFFERENT-NAS" : "NAS-UUID-1",
      progress: (completed) => {
        if (completed === 1 && !didDisconnect) {
          disconnected = true;
          didDisconnect = true;
        }
      },
    });
    const preview = await manager.preview(source, destinationParent, context);
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("卷已离线");
    expect(persisted()[0].status).toBe("interrupted");
    expect(persisted()[0].completedFiles).toBe(1);
    disconnected = false;
    replacementMounted = true;
    await expect(manager.resume(persisted()[0].id)).rejects.toThrow(
      "归档目标卷身份与预检记录不一致",
    );
    replacementMounted = false;
    const completed = await manager.resume(persisted()[0].id);
    expect(completed.status).toBe("completed");
    expect(completed.completedFiles).toBe(completed.inventory.totalFiles);
    expect(await fs.readFile(path.join(completed.finalPath, "素材", "B002.mov"))).toHaveLength(
      2048,
    );
    await expect(manager.resume(completed.id)).rejects.toThrow("可恢复状态");
    expect(
      (await fs.readdir(path.join(completed.finalPath, "素材"))).filter(
        (item) => item === "B002.mov",
      ),
    ).toHaveLength(1);
  });

  it("never deletes an unregistered conflicting file discovered during recovery", async () => {
    const { source, destinationParent } = await fixture("恢复冲突项目");
    let disconnected = false,
      didDisconnect = false;
    const { manager, persisted } = testManager({
      destinationParent,
      disconnected: () => disconnected,
      progress: (completed) => {
        if (completed === 1 && !didDisconnect) {
          disconnected = true;
          didDisconnect = true;
        }
      },
    });
    const preview = await manager.preview(source, destinationParent, context);
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("卷已离线");
    const interrupted = persisted()[0],
      pending = interrupted.inventory.files.find((file) => !file.verifiedAt)!;
    disconnected = false;
    const conflict = path.join(
      interrupted.finalPath,
      ...pending.relativePath.split("/"),
    );
    await fs.mkdir(path.dirname(conflict), { recursive: true });
    const external = Buffer.alloc(pending.size, 201);
    await fs.writeFile(conflict, external, { flag: "wx" });
    await expect(manager.resume(interrupted.id)).rejects.toThrow(/未删除/);
    expect(await fs.readFile(conflict)).toEqual(external);
  });

  it("rejects a symlink inserted into an interrupted target parent chain before any outside write", async () => {
    const { root, source, destinationParent } = await fixture(
      "恢复目标父链替换项目",
    );
    await fs.mkdir(path.join(source, "zzzz-late"));
    await fs.writeFile(
      path.join(source, "zzzz-late", "late.mov"),
      Buffer.alloc(4096, 73),
    );
    let disconnected = false,
      didDisconnect = false;
    const { manager, persisted } = testManager({
      destinationParent,
      disconnected: () => disconnected,
      progress: (completed) => {
        if (completed === 1 && !didDisconnect) {
          disconnected = true;
          didDisconnect = true;
        }
      },
    });
    const preview = await manager.preview(source, destinationParent, context);
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("卷已离线");

    const interrupted = persisted()[0],
      targetParent = path.join(interrupted.finalPath, "zzzz-late"),
      outside = path.join(root, "不属于归档目标的目录");
    expect(interrupted.status).toBe("interrupted");
    expect(
      interrupted.inventory.files.find(
        (file) => file.relativePath === "zzzz-late/late.mov",
      )?.verifiedAt,
    ).toBeUndefined();
    await fs.rm(targetParent, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, targetParent);

    disconnected = false;
    await expect(manager.resume(interrupted.id)).rejects.toThrow(
      /父链包含符号链接|通过符号链接/,
    );
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await fs.lstat(targetParent)).isSymbolicLink()).toBe(true);
    await expect(
      fs.lstat(path.join(outside, "late.mov")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps verified data complete when PNG publication fails and retries with a new report ID without overwriting the orphan PDF", async () => {
    const { source, destinationParent } = await fixture("报告恢复项目");
    let attempt = 0;
    const { manager } = testManager({
      destinationParent,
      report: async (snapshot, artifactReportId) => {
        attempt++;
        const directory = path.join(snapshot.finalPath, "Kocpy报告"),
          pngPath = path.join(
            directory,
            `Kocpy_NAS归档_${artifactReportId}.png`,
          ),
          pdf = Buffer.from(`pdf-attempt-${attempt}`),
          png = Buffer.from(`png-attempt-${attempt}`);
        if (attempt === 1) {
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(pngPath, "foreign-png", { flag: "wx" });
        }
        return { pdf, png };
      },
    });
    const preview = await manager.preview(source, destinationParent, context),
      task = await manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      });
    expect(task.status).toBe("completed");
    expect(task.reportStatus).toBe("failed");
    expect(task.error).toContain("数据已校验");
    const orphan = path.join(
      task.finalPath,
      "Kocpy报告",
      `Kocpy_NAS归档_${task.reportId}.pdf`,
    );
    expect(await fs.readFile(orphan, "utf8")).toBe("pdf-attempt-1");
    expect(
      await fs.readFile(
        path.join(
          task.finalPath,
          "Kocpy报告",
          `Kocpy_NAS归档_${task.reportId}.png`,
        ),
        "utf8",
      ),
    ).toBe("foreign-png");

    const retried = await manager.retryReports(task.id);
    expect(retried.reportStatus).toBe("completed");
    expect(retried.reportAttempts[1].artifactReportId).toBe(`${task.reportId}-R2`);
    expect(await fs.readFile(orphan, "utf8")).toBe("pdf-attempt-1");
    expect(await fs.readFile(retried.reportAttempts[1].pdfPath!, "utf8")).toBe(
      "pdf-attempt-2",
    );
    expect(await fs.readFile(retried.reportAttempts[1].pngPath!, "utf8")).toBe(
      "png-attempt-2",
    );
  });

  it("does not retain a ghost task when the first durable checkpoint fails", async () => {
    const { source, destinationParent } = await fixture("首次检查点失败项目");
    let rejectFirst = true;
    const { manager, persisted } = testManager({
      destinationParent,
      persist: async () => {
        if (rejectFirst) {
          rejectFirst = false;
          throw new Error("simulated first checkpoint failure");
        }
      },
    });
    const preview = await manager.preview(source, destinationParent, context),
      marker = path.join(
        destinationParent,
        `.${path.basename(source)}.kocpy-transfer-12345678-abcd-4000-8000-123456789abc.json`,
      );
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("simulated first checkpoint failure");
    expect(manager.list()).toEqual([]);
    expect(persisted()).toEqual([]);
    await expect(fs.lstat(preview.finalPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const completed = await manager.start({
      sourcePath: source,
      destinationParent,
      previewDigest: preview.inventory.digest,
      context,
    });
    expect(completed.status).toBe("completed");
    expect(manager.list()).toHaveLength(1);
    expect(persisted()).toHaveLength(1);
  });

  it("serializes concurrent task registration without losing either durable record", async () => {
    const { root, source, destinationParent } = await fixture("并发归档项目甲"),
      secondSource = path.join(root, "并发归档项目乙");
    await fs.cp(source, secondSource, { recursive: true });
    let releaseFirst!: () => void,
      firstRegistrationEntered!: () => void,
      id = 0;
    const firstRegistration = new Promise<void>((resolve) => {
        firstRegistrationEntered = resolve;
      }),
      firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
      { manager, persisted } = testManager({
        destinationParent,
        randomId: () =>
          `12345678-abcd-4000-8000-${String(++id).padStart(12, "0")}`,
        persist: async (_tasks, call) => {
          if (call === 1) {
            firstRegistrationEntered();
            await firstRelease;
          }
        },
      }),
      [firstPreview, secondPreview] = await Promise.all([
        manager.preview(source, destinationParent, context),
        manager.preview(secondSource, destinationParent, context),
      ]),
      first = manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: firstPreview.inventory.digest,
        context,
      });
    await firstRegistration;
    const second = manager.start({
      sourcePath: secondSource,
      destinationParent,
      previewDigest: secondPreview.inventory.digest,
      context,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirst();
    const completed = await Promise.all([first, second]);
    expect(completed.every((task) => task.status === "completed")).toBe(true);
    expect(new Set(manager.list().map((task) => task.id)).size).toBe(2);
    expect(new Set(persisted().map((task) => task.id)).size).toBe(2);
    for (const task of completed) {
      expect(await fs.lstat(task.finalPath).then((stat) => stat.isDirectory())).toBe(
        true,
      );
      expect(await fs.lstat(task.reportAttempts[0].pdfPath!)).toBeTruthy();
      expect(await fs.lstat(task.reportAttempts[0].pngPath!)).toBeTruthy();
    }
  });

  it("allows only one concurrent registration for the same final target", async () => {
    const { source, destinationParent } = await fixture("同目标并发项目");
    let releaseFirst!: () => void,
      firstRegistrationEntered!: () => void,
      id = 0;
    const firstRegistration = new Promise<void>((resolve) => {
        firstRegistrationEntered = resolve;
      }),
      firstRelease = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
      { manager, persisted } = testManager({
        destinationParent,
        randomId: () =>
          `12345678-abcd-4000-8000-${String(++id).padStart(12, "0")}`,
        persist: async (_tasks, call) => {
          if (call === 1) {
            firstRegistrationEntered();
            await firstRelease;
          }
        },
      }),
      preview = await manager.preview(source, destinationParent, context),
      first = manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      });
    await firstRegistration;
    const second = manager.start({
      sourcePath: source,
      destinationParent,
      previewDigest: preview.inventory.digest,
      context,
    });
    releaseFirst();
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toContain(
      "同一归档目标已经有登记任务",
    );
    expect(manager.list()).toHaveLength(1);
    expect(persisted()).toHaveLength(1);
  });

  it("resumes the same durable task when target creation failed before its marker existed", async () => {
    const { source, destinationParent } = await fixture("标记前离线项目");
    let disconnected = false;
    const { manager, persisted } = testManager({
      destinationParent,
      disconnected: () => disconnected,
      persist: async (_tasks, call) => {
        if (call === 1) disconnected = true;
      },
    });
    const preview = await manager.preview(source, destinationParent, context);
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("卷已离线");
    const failed = persisted()[0];
    expect(failed).toMatchObject({ status: "failed", targetCreated: false });
    await expect(fs.lstat(failed.markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(failed.finalPath)).rejects.toMatchObject({ code: "ENOENT" });

    disconnected = false;
    const completed = await manager.resume(failed.id);
    expect(completed.status).toBe("completed");
    expect(completed.recoveryEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "recovered-before-target-creation" }),
      ]),
    );
    expect(manager.list()).toHaveLength(1);
  });

  it("allows a new audited transfer after a completed target was deliberately moved", async () => {
    const { root, source, destinationParent } = await fixture("已移动历史归档项目");
    let id = 0;
    const { manager } = testManager({
      destinationParent,
      randomId: () =>
        `12345678-abcd-4000-8000-${String(++id).padStart(12, "0")}`,
    });
    const preview = await manager.preview(source, destinationParent, context),
      first = await manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
      moved = path.join(root, "人工移动后的历史归档");
    await fs.rename(first.finalPath, moved);
    const repeatedPreview = await manager.preview(source, destinationParent, context),
      second = await manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: repeatedPreview.inventory.digest,
        context,
      });
    expect(second.status).toBe("completed");
    expect(second.id).not.toBe(first.id);
    expect(manager.list()).toHaveLength(2);
    expect(await fs.lstat(moved).then((stat) => stat.isDirectory())).toBe(true);
    expect(await fs.lstat(second.finalPath).then((stat) => stat.isDirectory())).toBe(
      true,
    );
  });

  it("recovers the original publishing checkpoint after the final report commit fails", async () => {
    const { source, destinationParent } = await fixture("报告最终提交恢复项目");
    let rejectCompletedCheckpoint = true;
    const first = testManager({
      destinationParent,
      persist: async (tasks) => {
        if (
          rejectCompletedCheckpoint &&
          tasks[0]?.reportAttempts.at(-1)?.status === "completed"
        ) {
          rejectCompletedCheckpoint = false;
          throw new Error("simulated final report checkpoint failure");
        }
      },
    });
    const preview = await first.manager.preview(source, destinationParent, context);
    await expect(
      first.manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("simulated final report checkpoint failure");
    const durable = first.persisted(),
      publishing = durable[0].reportAttempts[0];
    expect(durable[0].reportStatus).toBe("generating");
    expect(publishing.status).toBe("publishing");
    expect(await fs.readFile(publishing.pdfPath!, "utf8")).toBe("pdf");
    expect(await fs.readFile(publishing.pngPath!, "utf8")).toBe("png");

    const restarted = testManager({ destinationParent });
    await restarted.manager.initialize(durable);
    const recovered = restarted.manager.list()[0];
    expect(recovered.reportStatus).toBe("completed");
    expect(recovered.reportAttempts).toHaveLength(1);
    expect(recovered.reportAttempts[0]).toMatchObject({
      artifactReportId: publishing.artifactReportId,
      status: "completed",
    });
    await expect(fs.lstat(recovered.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.lstat(
        path.join(
          recovered.finalPath,
          "Kocpy报告",
          `Kocpy_NAS归档_${recovered.reportId}-R2.pdf`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recover a publishing checkpoint through a replaced marker symlink", async () => {
    const { root, source, destinationParent } = await fixture(
      "发布恢复标记替换项目",
    );
    let rejectCompletedCheckpoint = true;
    const first = testManager({
      destinationParent,
      persist: async (tasks) => {
        if (
          rejectCompletedCheckpoint &&
          tasks[0]?.reportAttempts.at(-1)?.status === "completed"
        ) {
          rejectCompletedCheckpoint = false;
          throw new Error("simulated final report checkpoint failure");
        }
      },
    });
    const preview = await first.manager.preview(source, destinationParent, context);
    await expect(
      first.manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("simulated final report checkpoint failure");
    const durable = first.persisted(),
      attempt = durable[0].reportAttempts[0],
      externalMarker = path.join(root, "外部发布恢复标记.json"),
      markerBytes = await fs.readFile(durable[0].markerPath),
      pdfBytes = await fs.readFile(attempt.pdfPath!),
      pngBytes = await fs.readFile(attempt.pngPath!);
    await fs.rename(durable[0].markerPath, externalMarker);
    await fs.symlink(externalMarker, durable[0].markerPath);

    const restarted = testManager({ destinationParent });
    await restarted.manager.initialize(durable);
    const rejected = restarted.manager.list()[0];
    expect(rejected.reportStatus).toBe("failed");
    expect(rejected.reportAttempts[0].status).toBe("failed");
    expect(rejected.error).toContain("恢复标记不是安全的普通文件");
    expect(await fs.readFile(externalMarker)).toEqual(markerBytes);
    expect(await fs.readFile(attempt.pdfPath!)).toEqual(pdfBytes);
    expect(await fs.readFile(attempt.pngPath!)).toEqual(pngBytes);
    expect((await fs.lstat(rejected.markerPath)).isSymbolicLink()).toBe(true);
  });

  it("retries a completed marker cleanup on the next startup", async () => {
    const { source, destinationParent } = await fixture("标记清理重试项目");
    let rejectRemoval = true;
    const first = testManager({
      destinationParent,
      removeFile: async (file) => {
        if (rejectRemoval) {
          rejectRemoval = false;
          throw new Error("simulated marker unlink failure");
        }
        await fs.unlink(file);
      },
    });
    const preview = await first.manager.preview(source, destinationParent, context),
      completed = await first.manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      });
    expect(completed).toMatchObject({
      status: "completed",
      reportStatus: "completed",
    });
    expect(completed.error).toContain("临时任务所有权标记未能安全清理");
    expect((await fs.lstat(completed.markerPath)).isFile()).toBe(true);

    const offline = testManager({
      destinationParent,
      disconnected: () => true,
    });
    await expect(offline.manager.initialize(first.persisted())).resolves.toBeDefined();
    expect(offline.manager.list()[0].error).toContain("归档目标已离线");
    expect((await fs.lstat(completed.markerPath)).isFile()).toBe(true);

    const restarted = testManager({ destinationParent });
    await restarted.manager.initialize(offline.persisted());
    const recovered = restarted.manager.list()[0];
    expect(recovered.error).toBeUndefined();
    expect(recovered.recoveryEvents.at(-1)?.action).toBe(
      "completed-target-marker-cleanup-recovered",
    );
    await expect(fs.lstat(recovered.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("defers a marker probe IO error without aborting startup", async () => {
    const { root, source, destinationParent } = await fixture(
      "标记探测异常项目",
    );
    const first = testManager({
      destinationParent,
      removeFile: async () => {
        throw new Error("simulated marker cleanup failure");
      },
    });
    const preview = await first.manager.preview(source, destinationParent, context),
      completed = await first.manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
      parkedParent = path.join(root, "暂存的归档父目录");
    expect(completed.reportStatus).toBe("completed");
    expect((await fs.lstat(completed.markerPath)).isFile()).toBe(true);
    await fs.rename(destinationParent, parkedParent);
    await fs.writeFile(destinationParent, "temporary mount error fixture");

    const unavailable = testManager({ destinationParent });
    await expect(unavailable.manager.initialize(first.persisted())).resolves.toBeDefined();
    const deferred = unavailable.manager.list()[0];
    expect(deferred).toMatchObject({
      status: "completed",
      reportStatus: "completed",
    });
    expect(deferred.error).toContain("临时任务所有权标记未能安全清理");
    expect(deferred.error).toContain("原归档目标");

    await fs.unlink(destinationParent);
    await fs.rename(parkedParent, destinationParent);
    const recovered = testManager({ destinationParent });
    await recovered.manager.initialize(unavailable.persisted());
    expect(recovered.manager.list()[0].error).toBeUndefined();
    await expect(fs.lstat(completed.markerPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a changed publishing artifact and only creates R2 after explicit retry", async () => {
    const { source, destinationParent } = await fixture("报告检查点篡改项目");
    let rejectCompletedCheckpoint = true;
    const first = testManager({
      destinationParent,
      persist: async (tasks) => {
        if (
          rejectCompletedCheckpoint &&
          tasks[0]?.reportAttempts.at(-1)?.status === "completed"
        ) {
          rejectCompletedCheckpoint = false;
          throw new Error("simulated final report checkpoint failure");
        }
      },
    });
    const preview = await first.manager.preview(source, destinationParent, context);
    await expect(
      first.manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("simulated final report checkpoint failure");
    const durable = first.persisted(),
      publishing = durable[0].reportAttempts[0];
    await fs.writeFile(publishing.pdfPath!, "changed-after-publication");

    const restarted = testManager({ destinationParent });
    await restarted.manager.initialize(durable);
    const rejected = restarted.manager.list()[0];
    expect(rejected.reportStatus).toBe("failed");
    expect(rejected.reportAttempts).toHaveLength(1);
    expect(rejected.reportAttempts[0].status).toBe("failed");
    expect(await fs.readFile(publishing.pdfPath!, "utf8")).toBe(
      "changed-after-publication",
    );

    const retried = await restarted.manager.retryReports(rejected.id);
    expect(retried.reportStatus).toBe("completed");
    expect(retried.reportAttempts).toHaveLength(2);
    expect(retried.reportAttempts[1].artifactReportId).toBe(
      `${rejected.reportId}-R2`,
    );
    expect(await fs.readFile(publishing.pdfPath!, "utf8")).toBe(
      "changed-after-publication",
    );
  });

  it("never adopts or writes through a replaced report-directory symlink", async () => {
    const { root, source, destinationParent } = await fixture(
      "报告目录替换项目",
    );
    let rejectCompletedCheckpoint = true;
    const first = testManager({
      destinationParent,
      persist: async (tasks) => {
        if (
          rejectCompletedCheckpoint &&
          tasks[0]?.reportAttempts.at(-1)?.status === "completed"
        ) {
          rejectCompletedCheckpoint = false;
          throw new Error("simulated final report checkpoint failure");
        }
      },
    });
    const preview = await first.manager.preview(source, destinationParent, context);
    await expect(
      first.manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("simulated final report checkpoint failure");
    const durable = first.persisted(),
      attempt = durable[0].reportAttempts[0],
      reportRoot = path.dirname(attempt.pdfPath!),
      externalRoot = path.join(root, "归档外报告目录");
    await fs.rename(reportRoot, externalRoot);
    await fs.symlink(externalRoot, reportRoot);
    const externalPdf = await fs.readFile(path.join(externalRoot, path.basename(attempt.pdfPath!))),
      externalPng = await fs.readFile(path.join(externalRoot, path.basename(attempt.pngPath!)));

    const restarted = testManager({ destinationParent });
    await restarted.manager.initialize(durable);
    const rejected = restarted.manager.list()[0];
    expect(rejected.reportStatus).toBe("failed");
    expect(rejected.reportAttempts[0].status).toBe("failed");
    const retried = await restarted.manager.retryReports(rejected.id);
    expect(retried.reportStatus).toBe("failed");
    expect(retried.reportAttempts[1]).toMatchObject({
      artifactReportId: `${rejected.reportId}-R2`,
      status: "failed",
    });
    expect(await fs.readFile(path.join(externalRoot, path.basename(attempt.pdfPath!)))).toEqual(
      externalPdf,
    );
    expect(await fs.readFile(path.join(externalRoot, path.basename(attempt.pngPath!)))).toEqual(
      externalPng,
    );
    await expect(
      fs.lstat(path.join(externalRoot, `Kocpy_NAS归档_${rejected.reportId}-R2.pdf`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never writes an old failed report into a newer transfer at the same path", async () => {
    const { root, source, destinationParent } = await fixture(
      "旧报告归属隔离项目",
    );
    let renderCall = 0,
      id = 0;
    const { manager } = testManager({
      destinationParent,
      randomId: () =>
        `1234567${++id}-abcd-4000-8000-${String(id).padStart(12, "0")}`,
      report: async (snapshot, artifactReportId) => {
        renderCall++;
        if (renderCall === 1) {
          const reportRoot = path.join(snapshot.finalPath, "Kocpy报告");
          await fs.mkdir(reportRoot, { recursive: true });
          await fs.writeFile(
            path.join(reportRoot, `Kocpy_NAS归档_${artifactReportId}.png`),
            "foreign-png",
            { flag: "wx" },
          );
        }
        return {
          pdf: Buffer.from(`pdf-${renderCall}`),
          png: Buffer.from(`png-${renderCall}`),
        };
      },
    });
    const preview = await manager.preview(source, destinationParent, context),
      oldTask = await manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: preview.inventory.digest,
        context,
      });
    expect(oldTask).toMatchObject({ status: "completed", reportStatus: "failed" });
    expect(await fs.lstat(oldTask.markerPath).then((stat) => stat.isFile())).toBe(
      true,
    );
    const externalMarker = path.join(root, "外部保留的任务标记.json"),
      markerBytes = await fs.readFile(oldTask.markerPath);
    await fs.rename(oldTask.markerPath, externalMarker);
    await fs.symlink(externalMarker, oldTask.markerPath);
    await expect(manager.retryReports(oldTask.id)).rejects.toThrow(
      "恢复标记不是安全的普通文件",
    );
    expect(await fs.readFile(externalMarker)).toEqual(markerBytes);
    await fs.unlink(oldTask.markerPath);
    await fs.rename(externalMarker, oldTask.markerPath);
    const moved = path.join(root, "已移走的旧归档");
    await fs.rename(oldTask.finalPath, moved);
    const blockedPreview = await manager.preview(source, destinationParent, context);
    await expect(
      manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: blockedPreview.inventory.digest,
        context,
      }),
    ).rejects.toThrow("同一归档目标已经有登记任务");

    // Simulate an early candidate that removed its marker even though report
    // publication failed. It becomes read-only history and may release the
    // empty path, but it must never write reports into the next task.
    await fs.unlink(oldTask.markerPath);
    const replacementPreview = await manager.preview(
        source,
        destinationParent,
        context,
      ),
      replacement = await manager.start({
        sourcePath: source,
        destinationParent,
        previewDigest: replacementPreview.inventory.digest,
        context,
      });
    expect(replacement).toMatchObject({
      status: "completed",
      reportStatus: "completed",
    });
    await expect(manager.retryReports(oldTask.id)).rejects.toThrow(
      "原任务所有权标记不存在",
    );
    await expect(
      fs.lstat(
        path.join(
          replacement.finalPath,
          "Kocpy报告",
          `Kocpy_NAS归档_${oldTask.reportId}-R2.pdf`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks insufficient destination space before creating a task", async () => {
    const { source, destinationParent } = await fixture("空间不足项目"),
      { manager } = testManager({ destinationParent, availableBytes: 1024 });
    await expect(manager.preview(source, destinationParent, context)).rejects.toThrow(
      "可用空间不足",
    );
    expect(manager.list()).toEqual([]);
  });
});

describe("archive transfer PDF/PNG deterministic report contract", () => {
  it("renders the same required facts and contract digest in detailed PDF HTML and HD PNG HTML", () => {
    const snapshot: ArchiveTransferReportSnapshot = {
      schemaVersion: 1,
      reportId: "KAT-20260919T100000Z-12345678",
      transferId: "transfer-中文-1",
      archiveName: "长中文项目 & Archive",
      archiveNameSource: "project",
      shootingDate: "2026-09-18 至 2026-09-19",
      payloadFileCount: 1234,
      payloadBytes: 987654321,
      payloadHumanBytes: "941.90 MiB",
      payloadEmptyDirectories: 3,
      sourcePath: "/源/长中文路径/项目",
      finalPath: "/Volumes/NAS/归档/项目",
      startedAt: Date.UTC(2026, 8, 19, 1, 2, 3),
      completedAt: Date.UTC(2026, 8, 19, 2, 3, 4),
      hashAlgorithm: "SHA-256",
      verificationConclusion: "通过",
      inventoryDigest: "a".repeat(64),
      historicalEvidence: ["旧清单仍有异常"],
      evidenceBoundary: "只证明本次事实；不验证 ACL、xattr、权限或时间戳。",
    };
    const artifactId = snapshot.reportId,
      contract = archiveTransferReportContract(snapshot, artifactId),
      digest = archiveTransferContractDigest(contract),
      detail = buildArchiveTransferDetailHtml(snapshot, artifactId),
      summary = buildArchiveTransferSummaryHtml(snapshot, artifactId);
    expect(detail).toContain(`data-contract-digest="${digest}"`);
    expect(summary).toContain(`data-contract-digest="${digest}"`);
    for (const visible of [
      "长中文项目 &amp; Archive",
      "2026-09-18 至 2026-09-19",
      "1,234",
      "987,654,321",
      "941.90 MiB",
      "SHA-256",
      "通过",
      artifactId,
      "/Volumes/NAS/归档/项目",
      "不验证 ACL、xattr、权限或时间戳。",
    ]) {
      expect(detail).toContain(visible);
      expect(summary).toContain(visible);
    }
    expect(summary).toContain("1920px");
  });
});
