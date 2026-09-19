import { app, BrowserWindow, nativeImage } from "electron";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveTransferContractDigest,
  archiveTransferReportContract,
  buildArchiveTransferDetailHtml,
  buildArchiveTransferSummaryHtml,
} from "../src/main/archive-transfer-report";
import type { ArchiveTransferReportSnapshot } from "../src/main/archive-transfer";
import { withTemporaryReportHtml } from "../src/main/report-html";

async function render(html: string, size: { width: number; height: number }) {
  const window = new BrowserWindow({
    show: false,
    ...size,
    useContentSize: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await withTemporaryReportHtml(html, (file) => window.loadFile(file));
  await window.webContents
    .executeJavaScript("document.fonts.ready.then(() => true)", true)
    .catch(() => undefined);
  return window;
}

async function main() {
  await app.whenReady();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-archive-report-")),
    artifactReportId = "KAT-20260919T100000Z-12345678",
    snapshot: ArchiveTransferReportSnapshot = {
      schemaVersion: 1,
      reportId: artifactReportId,
      transferId: "12345678-abcd-4000-8000-123456789abc",
      archiveName: "中文归档报告验证",
      archiveNameSource: "folder",
      shootingDate: "未记录",
      payloadFileCount: 12,
      payloadBytes: 123456789,
      payloadHumanBytes: "117.74 MiB",
      payloadEmptyDirectories: 2,
      sourcePath: "/synthetic/source/中文项目",
      finalPath: "/synthetic/NAS/中文项目",
      startedAt: Date.UTC(2026, 8, 19, 1, 2, 3),
      completedAt: Date.UTC(2026, 8, 19, 2, 3, 4),
      hashAlgorithm: "SHA-256",
      verificationConclusion: "通过",
      inventoryDigest: "a".repeat(64),
      historicalEvidence: ["旧清单异常保持原结论"],
      evidenceBoundary: "只验证路径、文件内容、精确字节数和空目录。",
    },
    contract = archiveTransferReportContract(snapshot, artifactReportId),
    digest = archiveTransferContractDigest(contract),
    detailHtml = buildArchiveTransferDetailHtml(snapshot, artifactReportId),
    summaryHtml = buildArchiveTransferSummaryHtml(snapshot, artifactReportId);
  if (
    !detailHtml.includes(`data-contract-digest="${digest}"`) ||
    !summaryHtml.includes(`data-contract-digest="${digest}"`)
  )
    throw new Error("PDF 与 PNG 没有使用同一份报告合同");
  let detail: BrowserWindow | undefined, summary: BrowserWindow | undefined;
  try {
    detail = await render(detailHtml, { width: 1240, height: 1754 });
    const pdf = await detail.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.35, bottom: 0.35, left: 0.3, right: 0.3 },
    });
    summary = await render(summaryHtml, { width: 1920, height: 1080 });
    const png = (await summary.webContents.capturePage({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })).toPNG();
    const pngSize = nativeImage.createFromBuffer(png).getSize();
    if (pdf.length < 10_000) throw new Error(`PDF 太小：${pdf.length}`);
    if (png.length < 10_000) throw new Error(`PNG 太小：${png.length}`);
    if (pngSize.width < 1920 || pngSize.height < 1080)
      throw new Error(`PNG 分辨率不足：${pngSize.width}x${pngSize.height}`);
    const pdfPath = path.join(root, "report.pdf"),
      pngPath = path.join(root, "summary.png");
    await fs.writeFile(pdfPath, pdf, { flag: "wx" });
    await fs.writeFile(pngPath, png, { flag: "wx" });
    console.log(
      JSON.stringify({
        status: "PASS",
        contractDigest: digest,
        pdfBytes: pdf.length,
        pngBytes: png.length,
        pngSize,
        isolatedTemporaryDirectory: true,
      }),
    );
  } finally {
    detail?.destroy();
    summary?.destroy();
    await fs.rm(root, { recursive: true, force: true });
    app.quit();
  }
}

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
