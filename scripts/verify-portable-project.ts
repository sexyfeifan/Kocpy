// Executes in each exact packaged runtime. Generated fixtures only, no user media.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  preparePortableProject,
  publishPortableProject,
  verifyPortablePayload,
} from "../src/main/portable-project";
import {
  ArchiveTransferManager,
  validateArchiveTransferTasks,
} from "../src/main/archive-transfer";
import { validatePortableHistory } from "../src/common/portable-project";
import type { ProjectConfig } from "../src/main/types";
async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "kocpy-portable-runtime-"),
  );
  try {
    const source = path.join(root, "SYNTHETIC-PROJECT"),
      destination = path.join(root, "SIMULATED-NAS");
    await fs.mkdir(source);
    await fs.mkdir(destination);
    await fs.writeFile(path.join(source, "clip.mov"), Buffer.alloc(8193, 17));
    await fs.writeFile(
      path.join(source, ".associated.xml"),
      "generated sidecar",
    );
    const project: ProjectConfig = {
      id: "synthetic-portable-project",
      name: "合成随盘项目",
      devices: ["FX3"],
      volumePrefix: "CARD_",
      shootingDateStart: "2026-10-15",
      shootingDateEnd: "2026-10-16",
      projectTimeZone: "Europe/Paris",
      shootingDayTimeZones: { "2026-10-16": "Asia/Shanghai" },
      shootingDayBoundaryHour: 6,
    };
    const first = await publishPortableProject(
      await preparePortableProject(source, project),
      "合成操作人",
    );
    await verifyPortablePayload(source, first.sha256);
    assert.equal(first.document.project.projectTimeZone, "Europe/Paris");
    assert.equal(first.document.project.shootingDayTimeZones?.["2026-10-16"], "Asia/Shanghai");
    const sourceSnapshot = await fs.readFile(path.join(source, "clip.mov"));
    let stored: unknown;
    const manager = new ArchiveTransferManager({
      identifyVolume: async () => ({
        id: "synthetic-same-volume",
        uuid: "synthetic-same-volume",
        name: "simulated only",
      }),
      availableBytes: async () => 1024 ** 3,
      persist: async (t) => {
        stored = structuredClone(t);
      },
      renderReports: async (snapshot) => ({
        pdf: Buffer.from(`synthetic-only-pdf-${snapshot.archiveName}`),
        png: Buffer.from("synthetic-only-png"),
      }),
    });
    const context = {
      projectId: project.id,
      portableProjectSha256: first.sha256,
      archiveName: project.name,
      archiveNameSource: "project" as const,
      shootingDate: "未记录实际拍摄日期",
      historicalEvidence: ["同一内盘模拟，不是实际 NAS 或物理独立性验收"],
    };
    const preview = await manager.preview(source, destination, context);
    const task = await manager.start({
      sourcePath: source,
      destinationParent: destination,
      previewDigest: preview.inventory.digest,
      context,
    });
    assert.equal(task.status, "completed");
    assert.equal(task.portableProjectSha256, first.sha256);
    assert.equal(task.reportStatus, "completed");
    validateArchiveTransferTasks(stored);
    assert.deepEqual(
      await fs.readFile(path.join(task.finalPath, "clip.mov")),
      sourceSnapshot,
    );
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(path.join(task.finalPath, ".kocpyproject")))
        .digest("hex"),
      first.sha256,
    );
    await fs.unlink(path.join(source, "clip.mov"));
    const prepared = await preparePortableProject(source, project);
    assert.deepEqual(prepared.inspection.missing, ["clip.mov"]);
    await assert.rejects(
      publishPortableProject(prepared, "合成操作人"),
      /逐项确认/,
    );
    const revision = await publishPortableProject(
      prepared,
      "合成操作人",
      ["clip.mov"],
      "合成测试中的授权排除",
    );
    assert.equal(revision.document.previousSha256, first.sha256);
    await verifyPortablePayload(source, revision.sha256);
    validatePortableHistory([
      {
        id: "synthetic-receipt",
        projectId: project.id,
        sha256: revision.sha256,
        revision: revision.document.revision,
        root: source,
        operator: "合成操作人",
        importedAt: Date.now(),
        project: revision.document.project,
        rolls: [],
        provenance: revision.document.provenance,
        files: revision.document.files.length,
        bytes: 17,
        exclusions: 1,
      },
    ]);
    console.log(
      JSON.stringify({
        status: "PASS",
        architecture: process.arch,
        runtime: process.version,
        cases: [
          "baseline-roundtrip",
          "frozen-project-NAS-transfer",
          "independent-target-content",
          "metadata-bytes-preserved",
          "persisted-recovery-schema",
          "intentional-missing-revision",
          "portable-history-validation",
        ],
        limitation:
          "isolated same-volume fixtures; no physical NAS/independence claim",
      }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
