import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ArchiveTransferManager,
  archiveTransferInternals,
  type ArchiveTransferContext,
  type ArchiveTransferReportSnapshot,
  type ArchiveTransferTask,
} from "../src/main/archive-transfer";
import {
  archiveTransferContractDigest,
  archiveTransferReportContract,
  buildArchiveTransferDetailHtml,
  buildArchiveTransferSummaryHtml,
} from "../src/main/archive-transfer-report";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

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
  report?: (
    snapshot: ArchiveTransferReportSnapshot,
    artifactReportId: string,
  ) => Promise<{ pdfPath: string; pngPath: string }>;
  availableBytes?: number;
}) {
  let persisted: ArchiveTransferTask[] = [];
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
      persisted = structuredClone(tasks);
    },
    renderReports:
      options?.report ||
      (async (snapshot, artifactReportId) => {
        const directory = path.join(snapshot.finalPath, "Kocpy报告"),
          pdfPath = path.join(directory, `${artifactReportId}.pdf`),
          pngPath = path.join(directory, `${artifactReportId}.png`);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(pdfPath, "pdf", { flag: "wx" });
        await fs.writeFile(pngPath, "png", { flag: "wx" });
        return { pdfPath, pngPath };
      }),
    onProgress: (value) => options?.progress?.(value.completedFiles),
    now: (() => {
      let value = Date.UTC(2026, 8, 19, 10, 0, 0);
      return () => value++;
    })(),
    randomId: () => "12345678-abcd-4000-8000-123456789abc",
  });
  return { manager, persisted: () => persisted };
}

describe("independent NAS archive transfer", () => {
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
      "NAS 卷身份与预检记录不一致",
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

  it("keeps verified data complete when PNG publication fails and retries with a new report ID without overwriting the orphan PDF", async () => {
    const { source, destinationParent } = await fixture("报告恢复项目");
    let attempt = 0;
    const { manager } = testManager({
      destinationParent,
      report: async (snapshot, artifactReportId) => {
        attempt++;
        const directory = path.join(snapshot.finalPath, "Kocpy报告"),
          pdfPath = path.join(directory, `${artifactReportId}.pdf`),
          pngPath = path.join(directory, `${artifactReportId}.png`);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(pdfPath, `pdf-attempt-${attempt}`, { flag: "wx" });
        if (attempt === 1) throw new Error("simulated PNG publication failure");
        await fs.writeFile(pngPath, `png-attempt-${attempt}`, { flag: "wx" });
        return { pdfPath, pngPath };
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
    const orphan = path.join(task.finalPath, "Kocpy报告", `${task.reportId}.pdf`);
    expect(await fs.readFile(orphan, "utf8")).toBe("pdf-attempt-1");

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
