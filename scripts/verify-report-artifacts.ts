import { app, BrowserWindow, nativeImage } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildArchiveTransferDetailHtml,
  buildArchiveTransferSummaryHtml,
} from "../src/main/archive-transfer-report";
import type { ArchiveTransferReportSnapshot } from "../src/main/archive-transfer";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { generateReport, generateDailyReport, generateProjectReport } from "../src/main/backup/ReportGenerator";
import { analyzeBackupSelection, finalizeBackupSelection } from "../src/main/backup-selection";
import { dailyDeliveryReportHtml } from "../src/main/mixed-day-delivery";
import { withTemporaryReportHtml } from "../src/main/report-html";
import type {
  BackupTask,
  DailyDeliveryRun,
  FileRecord,
  ProjectConfig,
} from "../src/main/types";

const OUTPUT_ENV = "KOCPY_REPORT_QA_OUTPUT_DIR";
const syntheticRoot = "/Kocpy-QA/SYNTHETIC-ONLY";

interface ArtifactResult {
  kind: "pdf" | "png";
  label: string;
  path: string;
  bytes: number;
  sha256: string;
  pages?: number;
  pixels?: { width: number; height: number };
}

const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

function contains(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function outputDirectory() {
  const configured = process.env[OUTPUT_ENV]?.trim();
  if (!configured)
    throw new Error(
      `${OUTPUT_ENV} 未设置；报告 QA 只允许写入显式指定的仓库外目录`,
    );
  if (!path.isAbsolute(configured))
    throw new Error(`${OUTPUT_ENV} 必须是绝对路径`);
  await fs.mkdir(configured, { recursive: true, mode: 0o700 });
  const [repository, root] = await Promise.all([
    fs.realpath(process.cwd()),
    fs.realpath(configured),
  ]);
  const runDirectory = path.join(
    root,
    `Kocpy-report-QA-${safeTimestamp()}-${randomUUID().slice(0, 8)}`,
  );
  if (contains(repository, runDirectory))
    throw new Error(`${OUTPUT_ENV} 解析后位于仓库内，已拒绝写入`);
  await fs.mkdir(runDirectory, { mode: 0o700 });
  return runDirectory;
}

async function writeExclusive(file: string, value: Buffer) {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const reread = await fs.readFile(file);
  if (reread.length !== value.length || sha256(reread) !== sha256(value))
    throw new Error(`写入后回读不一致：${file}`);
}

async function loadedWindow(
  html: Buffer | string,
  size: { width: number; height: number },
) {
  const report = new BrowserWindow({
    show: false,
    ...size,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await withTemporaryReportHtml(html, (file) => report.loadFile(file));
    await report.webContents.executeJavaScript(
      "document.fonts.ready.then(() => true)",
      true,
    );
    return report;
  } catch (error) {
    report.destroy();
    throw error;
  }
}

async function renderPdf(html: Buffer | string) {
  const report = await loadedWindow(html, { width: 1240, height: 1754 });
  try {
    const pdf = await report.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      preferCSSPageSize: true,
    });
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) || pdf.length < 10_000)
      throw new Error(`PDF 结构或体积异常：${pdf.length} bytes`);
    return pdf;
  } finally {
    report.destroy();
  }
}

async function renderPng(html: Buffer | string) {
  const report = await loadedWindow(html, { width: 1920, height: 1080 });
  try {
    const png = (
      await report.webContents.capturePage({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      })
    ).toPNG();
    const image = nativeImage.createFromBuffer(png),
      pixels = image.getSize();
    if (
      !png.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ) ||
      png.length < 10_000 ||
      pixels.width < 1920 ||
      pixels.height < 1080 ||
      pixels.width * 9 !== pixels.height * 16
    )
      throw new Error(
        `PNG 结构、体积或分辨率异常：${png.length} bytes，${pixels.width}x${pixels.height}`,
      );
    return { png, pixels };
  } finally {
    report.destroy();
  }
}

function syntheticChecksum(seed: string) {
  return createHash("sha256").update(`Kocpy synthetic QA:${seed}`).digest("hex");
}

function syntheticFileRecords(): FileRecord[] {
  const files = [
    ["DCIM/A001/C001_20260919_080001.MOV", 5_421_776_384],
    ["DCIM/A001/C002_20260919_081423.MOV", 8_934_998_016],
    ["DCIM/A001/C003_20260919_093010.MOV", 12_180_537_344],
    ["DCIM/A001/C004_20260918_221531.MOV", 4_662_476_800],
    ["AUDIO/250919_001.WAV", 1_023_991_808],
    ["AUDIO/250919_002.WAV", 842_006_528],
    ["STILLS/DSC09001.ARW", 51_380_224],
    ["STILLS/DSC09001.JPG", 12_582_912],
    ["STILLS/DSC09002.ARW", 50_954_240],
    ["STILLS/DSC09002.JPG", 12_320_768],
    ["PRIVATE/M4ROOT/GENERAL/STATUS.BIN", 4_096],
    ["PRIVATE/M4ROOT/MEDIAPRO.XML", 18_432],
  ] as const;
  return files.map(([relativePath, size]) => {
    const checksum = syntheticChecksum(relativePath);
    return {
      name: path.basename(relativePath),
      relativePath,
      size,
      srcChecksum: checksum,
      destinations: ["Backup-A", "Backup-B"].map((destination) => ({
        path: `${syntheticRoot}/${destination}/品牌短片/20260919/A机/A001/${relativePath}`,
        checksum,
        verified: true,
      })),
    };
  });
}

function syntheticTask(): BackupTask {
  const engine = new BackupEngine(),
    task = engine.createTask({
      projectId: "qa-project-20260919",
      projectName: "城市人物志 · 秋季样片",
      projectStartDate: "2026-09-19",
      name: "A001",
      namingTemplate: "A001",
      sourcePath: `${syntheticRoot}/SOURCE/CARD-A001`,
      destinationPaths: [
        `${syntheticRoot}/Backup-A`,
        `${syntheticRoot}/Backup-B`,
      ],
      devices: ["A机 · FX6"],
      cameraPosition: "A机",
      hashAlgorithm: "sha256",
      shootingDate: "2026-09-19",
      automaticPdf: true,
      includeHidden: true,
    }),
    files = syntheticFileRecords(),
    totalBytes = files.reduce((sum, file) => sum + file.size, 0),
    startedAt = Date.parse("2026-09-19T00:13:06.000Z"),
    completedAt = Date.parse("2026-09-19T01:08:42.000Z"),
    assessmentId = "qa-storage-assessment-20260919";
  task.status = "completed";
  task.startedAt = startedAt;
  task.completedAt = completedAt;
  task.lastVerifiedAt = completedAt;
  task.totalFiles = files.length;
  task.completedFiles = files.length;
  task.totalBytes = totalBytes;
  task.transferredBytes = totalBytes * 2;
  task.physicalWrittenBytes = totalBytes * 2;
  task.verifiedBytes = totalBytes * 2;
  task.copyProgress = 100;
  task.verifyProgress = 100;
  task.verifyCompletedFiles = files.length * 2;
  task.verifyTotalFiles = files.length * 2;
  task.fileRecords = files;
  task.currentFile = "";
  task.verifyLog = files.map((file) => `✓ ${file.relativePath} → 两个隔离合成目的地`);
  task.inventoryScope = {
    policy: task.inventoryPolicy!,
    capturedAt: startedAt,
    sourcePath: task.sourcePath,
    fingerprint: syntheticChecksum("complete-inventory"),
    includedFiles: files.length,
    includedBytes: totalBytes,
    includedDirectories: 6,
    includedDirectoryPaths: [
      "AUDIO",
      "DCIM",
      "DCIM/A001",
      "PRIVATE",
      "PRIVATE/M4ROOT",
      "STILLS",
    ],
    excludedFiles: 0,
    excludedDirectories: 0,
    excludedBytes: 0,
    exclusions: [],
  };
  task.sourceHashPerformance = {
    average: 817_889_280,
    peak: 1_092_616_192,
    p50: 796_917_760,
    p95: 1_006_632_960,
    samples: 42,
    stalls: 0,
  };
  task.sourceCopyReadPerformance = {
    average: 713_031_680,
    peak: 964_689_920,
    p50: 692_060_160,
    p95: 901_775_360,
    samples: 42,
    stalls: 1,
  };
  task.faultTimeline = [
    { at: startedAt, phase: "copying", level: "info", message: "开始完整素材卷复制" },
    { at: startedAt + 1_420_000, phase: "verifying", level: "info", message: "两个目的地开始独立回读" },
    { at: completedAt, phase: "completed", level: "info", message: "复制与逐文件校验完成" },
  ];
  task.destinations.forEach((destination, index) => {
    const volume = index ? "QA-BACKUP-B" : "QA-BACKUP-A";
    destination.resolvedPath = `${syntheticRoot}/${index ? "Backup-B" : "Backup-A"}/品牌短片/20260919/A机/A001`;
    destination.label = index ? "隔离合成副本 B" : "隔离合成副本 A";
    destination.verified = true;
    destination.bytesWritten = totalBytes;
    destination.copiedBytes = totalBytes;
    destination.verifiedBytes = totalBytes;
    destination.copyProgress = 100;
    destination.verifyProgress = 100;
    destination.volumeId = `qa-disk-${index + 1}`;
    destination.volumeUuid = volume;
    destination.volumeName = volume;
    destination.storageEvidence = {
      assessmentId,
      checkedAt: completedAt,
      volumeUuid: volume,
      kind: "local-physical",
      domains: [`disk${index + 8}`],
      reason: "仅用于发布前报告版式检查的隔离合成证据",
    };
    destination.performance = {
      average: index ? 603_979_776 : 650_117_120,
      peak: index ? 838_860_800 : 943_718_400,
      p50: index ? 587_202_560 : 629_145_600,
      p95: index ? 796_917_760 : 901_775_360,
      samples: 42,
      stalls: index,
    };
    destination.verifyPerformance = {
      average: index ? 540_016_640 : 566_231_040,
      peak: index ? 734_003_200 : 786_432_000,
      p50: index ? 524_288_000 : 545_259_520,
      p95: index ? 702_545_920 : 754_974_720,
      samples: 42,
      stalls: 0,
    };
  });
  return task;
}

/** Real isolated bytes create a valid frozen plan; completion/storage fields
 * below are explicitly synthetic report-layout fixtures, not hardware evidence. */
async function syntheticSelectionTask(directory: string) {
  const sourcePath = path.join(directory, "合成输入-仅用于报告版式检查"),
    longPart = "多日拍摄中文关联元数据路径用于断行检查".repeat(3),
    files = [
      `20260917/${longPart}/20260917_A001.mov`,
      `20260917/${longPart}/20260917_A001.xml`,
      "20260918/20260918_A002.mov", "20260918/20260918_A002.xml",
      "20260919/20260919_A003.mov", "20260919/20260919_A003.xml",
      "共享索引/CameraIndex.bin", "原始清单.mhl",
    ];
  for (const relativePath of files) {
    const absolutePath = path.join(sourcePath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, `Synthetic report-layout fixture only: ${relativePath}\n`, { flag: "wx" });
  }
  const project: ProjectConfig = {
    id: "synthetic-selection-project", name: "合成样本 · 城市人物志跨日选定范围版式检查",
    devices: ["A机 · FX6 临时设备"], volumePrefix: "QA", requiredCopies: 2,
    startDate: "2026-09-17", endDate: "2026-09-19",
  };
  const deps = {
    identifyVolume: async () => ({ id: "synthetic-source", uuid: "SYNTHETIC-SOURCE", name: "仅合成版式数据" }),
    now: () => Date.parse("2026-09-19T01:00:00.000Z"),
  };
  const preview = await analyzeBackupSelection({ sourcePath, projectId: project.id }, deps);
  const selection = await finalizeBackupSelection(preview, {
    selectedDates: ["2026-09-19"],
    operator: "合成操作人 <排版检查> · 不代表真实拍摄或硬件验收 · 长姓名与确认说明",
    allowUnprotectedExclusions: true,
  }, deps);
  if (selection.excludedFiles.length !== 4 || selection.wholeCardCovered)
    throw new Error("报告合成样本未得到预期的跨日选定范围");
  const engine = new BackupEngine(), task = engine.createTask({
    projectId: project.id, projectName: project.name, name: "选定范围合成任务 · 保留共享关联文件",
    namingTemplate: "QA-selected", sourcePath, selection, hashAlgorithm: "sha256",
    devices: project.devices, cameraPosition: "B", shootingDate: "2026-09-19",
    destinationPaths: [`${syntheticRoot}/NAS/客户交付/长路径/${longPart}/${longPart}`],
    generateThumbnails: false,
  });
  task.status = "completed";
  task.startedAt = Date.parse("2026-09-19T01:00:01.000Z");
  task.completedAt = Date.parse("2026-09-19T01:10:01.000Z");
  task.completedFiles = task.totalFiles;
  task.copyProgress = 100;
  task.verifyProgress = 100;
  task.verifiedBytes = task.totalBytes;
  task.transferredBytes = task.totalBytes;
  task.destinations[0].resolvedPath = `${task.destinations[0].path}/QA-selected`;
  task.destinations[0].verified = true;
  task.destinations[0].volumeUuid = "SYNTHETIC-DESTINATION";
  task.destinations[0].bytesWritten = task.totalBytes;
  const included = new Set(selection.includedPaths);
  task.fileRecords = selection.sourceFiles.filter(file => included.has(file.relativePath)).map(file => ({
    name: path.basename(file.relativePath), relativePath: file.relativePath, size: file.size, srcChecksum: file.sha256,
    destinations: [{ path: path.join(task.destinations[0].resolvedPath!, file.relativePath), checksum: file.sha256, verified: true }],
  }));
  task.faultTimeline = [
    { at: task.startedAt, phase: "scanning", level: "warning", message: `合成扫描事件：${sourcePath}/${longPart}/${longPart}/20260917_A001.xml。此消息用于检查长 Unicode 路径不被表格右边界裁切，并不代表真实素材错误。` },
    { at: task.startedAt + 1000, phase: "copying", level: "info", message: "保留共享索引和原始清单；用户未选择旧日期关联文件组，未复制的文件不计作完整卡副本。" },
    { at: task.completedAt, phase: "completed", level: "info", message: "仅用于 PDF 版式预览的合成完成状态；不是硬件验收结论。" },
  ];
  return { task, project };
}

function syntheticDailyDelivery(task: BackupTask): DailyDeliveryRun {
  const selected = task.fileRecords.filter((file) =>
      /20260919|250919/.test(file.relativePath),
    ),
    completedAt = Date.parse("2026-09-19T01:34:28.000Z");
  return {
    id: "daily-delivery-qa-20260919",
    sourceTaskId: task.id,
    projectId: task.projectId,
    projectNameSnapshot: task.reportContext?.projectName,
    shootingDate: "2026-09-19",
    operator: "发布前隔离合成数据验收",
    createdAt: Date.parse("2026-09-19T01:10:00.000Z"),
    startedAt: Date.parse("2026-09-19T01:11:03.000Z"),
    completedAt,
    status: "completed",
    sourceDestinationId: task.destinations[0].id,
    sourceRoot: task.destinations[0].resolvedPath!,
    sourceVolumeId: task.destinations[0].volumeId,
    sourceVolumeUuid: task.destinations[0].volumeUuid,
    destinationParent: `${syntheticRoot}/Daily-Delivery`,
    finalPath: `${syntheticRoot}/Daily-Delivery/城市人物志_20260919_A机`,
    destinationVolumeId: "qa-delivery-disk",
    destinationVolumeUuid: "QA-DELIVERY",
    hashAlgorithm: "sha256",
    allocationDigest: syntheticChecksum("daily-allocation"),
    totalFiles: selected.length,
    totalBytes: selected.reduce((sum, file) => sum + file.size, 0),
    completedFiles: selected.length,
    completedBytes: selected.reduce((sum, file) => sum + file.size, 0),
    files: selected.map((file) => ({
      relativePath: file.relativePath,
      size: file.size,
      sourceChecksum: file.srcChecksum,
      sourceVerifiedAt: task.completedAt!,
      deliveredChecksum: file.srcChecksum,
      verified: true,
    })),
    reportStatus: "completed",
  };
}

function syntheticArchiveSnapshot(): ArchiveTransferReportSnapshot {
  return {
    schemaVersion: 1,
    reportId: "KAT-20260919T060412Z-QA137001",
    transferId: "archive-transfer-qa-20260919",
    archiveName: "城市人物志 · 2026 秋季拍摄项目",
    archiveNameSource: "project",
    shootingDate: "2026-09-12 至 2026-09-19",
    payloadFileCount: 28_416,
    payloadBytes: 8_942_771_224_576,
    payloadHumanBytes: "8.13 TiB",
    payloadEmptyDirectories: 3,
    sourcePath: `${syntheticRoot}/PROJECTS/城市人物志_2026秋季拍摄项目`,
    finalPath: `${syntheticRoot}/NAS/影视归档/2026/城市人物志_2026秋季拍摄项目`,
    startedAt: Date.parse("2026-09-19T02:18:11.000Z"),
    completedAt: Date.parse("2026-09-19T06:04:12.000Z"),
    hashAlgorithm: "SHA-256",
    verificationConclusion: "通过",
    inventoryDigest: syntheticChecksum("archive-inventory"),
    historicalEvidence: [
      "所有完整素材卷均保留首次完成校验快照",
      "当日交付属于独立派生范围，不替代完整卡副本",
    ],
    evidenceBoundary:
      "本报告仅证明该次 NAS 转存中冻结的路径、文件内容、精确字节数与空目录经逐文件独立回读一致；不证明未纳入源文件夹的素材存在，也不替代人工交接。",
  };
}

async function saveArtifact(
  directory: string,
  filename: string,
  kind: "pdf" | "png",
  label: string,
  value: Buffer,
  extra: Pick<ArtifactResult, "pages" | "pixels"> = {},
) {
  const file = path.join(directory, filename);
  await writeExclusive(file, value);
  return {
    kind,
    label,
    path: file,
    bytes: value.length,
    sha256: sha256(value),
    ...extra,
  } satisfies ArtifactResult;
}

async function main() {
  await app.whenReady();
  // Keep the Electron process alive while sequential off-screen report windows
  // are destroyed. Without this owner window, a headless macOS invocation can
  // exit after the first print job and leave an incomplete evidence directory.
  const keeper = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    }),
    directory = await outputDirectory(),
    task = syntheticTask(),
    delivery = syntheticDailyDelivery(task),
    archive = syntheticArchiveSnapshot(),
    artifactReportId = archive.reportId;
  const results: ArtifactResult[] = [];
  try {
    results.push(
      await saveArtifact(
        directory,
        "01-普通任务-首次完成校验快照.pdf",
        "pdf",
        "普通任务首次完成报告",
        await renderPdf(
          await generateReport(task, {
            generatedAt: Date.parse("2026-09-19T01:08:42.000Z"),
          }),
        ),
      ),
    );
    results.push(
      await saveArtifact(
        directory,
        "02-完整卡-当日交付校验报告.pdf",
        "pdf",
        "完整卡当日交付报告",
        await renderPdf(dailyDeliveryReportHtml(task, delivery)),
      ),
    );
    results.push(
      await saveArtifact(
        directory,
        "03-NAS归档-详细校验报告.pdf",
        "pdf",
        "NAS 归档详细报告",
        await renderPdf(buildArchiveTransferDetailHtml(archive, artifactReportId)),
      ),
    );
    const summary = await renderPng(
      buildArchiveTransferSummaryHtml(archive, artifactReportId),
    );
    results.push(
      await saveArtifact(
        directory,
        "04-NAS归档-图片摘要.png",
        "png",
        "NAS 归档图片摘要",
        summary.png,
        { pixels: summary.pixels },
      ),
    );
    const selected = await syntheticSelectionTask(directory);
    for (const [filename, label, html] of [
      ["05-选定范围-任务报告-合成版式.pdf", "选定范围任务报告（合成版式，非硬件证据）", await generateReport(selected.task)],
      ["06-选定范围-拍摄日报告-合成版式.pdf", "选定范围拍摄日报告（合成版式，非硬件证据）", await generateDailyReport([selected.task], "2026-09-19", selected.project.name)],
      ["07-选定范围-项目报告-合成版式.pdf", "选定范围项目报告（合成版式，非硬件证据）", await generateProjectReport(selected.project, [selected.task])],
    ] as const) {
      const text = html.toString();
      for (const required of ["完整源扫描 8 个文件", "本次选择 4 个", "未复制 4 个", "未保护 4 个", "合成操作人 &lt;排版检查&gt;"])
        if (!text.includes(required)) throw new Error(`${filename} 缺少范围证据：${required}`);
      if (!text.includes("A机 · FX6 临时设备 · B"))
        throw new Error(`${filename} 缺少设备或机位信息`);
      results.push(await saveArtifact(directory, filename, "pdf", label, await renderPdf(html)));
    }
    const crossDay = structuredClone(task);
    crossDay.dateAllocation = { schemaVersion: 1, sourceTaskId: crossDay.id,
      sourceEvidenceDigest: syntheticChecksum("cross-day-layout"), generatedAt: 1, updatedAt: 2,
      groups: crossDay.fileRecords.map((file, index) => ({
        id: syntheticChecksum(file.relativePath), label: file.name, relativePaths: [file.relativePath],
        files: 1, bytes: file.size, suggestionBasis: "embedded-media", suggestionConfidence: "review", evidence: [],
        assignedDate: index === 2 ? undefined : index === 1 ? "2026-09-20" : "2026-09-19",
        confirmedAt: index === 2 ? undefined : 2, confirmedBy: index === 2 ? undefined : "合成归属确认人",
      })) };
    const crossDayHtml = await generateProjectReport({ id: crossDay.projectId!, name: "合成跨午夜项目 · 文件归属复核",
      devices: crossDay.devices, volumePrefix: "QA_", requiredCopies: 2,
      shootingDateStart: "2026-09-19", shootingDateEnd: "2026-09-20" }, [crossDay]);
    if (!crossDayHtml.toString().includes("2026-09-20<br>已确认归属") || !crossDayHtml.toString().includes("待确认归属"))
      throw new Error("跨日报告未保留逐文件归属或待确认状态");
    results.push(await saveArtifact(directory, "08-跨午夜-逐文件归属与待确认.pdf", "pdf",
      "跨午夜逐文件归属与待确认（合成版式）", await renderPdf(crossDayHtml)));
    const manifest = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "PASS",
          generatedAt: new Date().toISOString(),
          evidenceBoundary:
            "只使用脚本内构造的隔离合成数据；未访问任何真实素材、项目记录或生产路径。",
          outputDirectory: directory,
          artifacts: results,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeExclusive(path.join(directory, "QA结果.json"), manifest);
    console.log(
      JSON.stringify(
        { status: "PASS", outputDirectory: directory, artifacts: results },
        null,
        2,
      ),
    );
  } finally {
    keeper.destroy();
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
