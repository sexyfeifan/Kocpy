import { createHash } from "node:crypto";
import type { ArchiveTransferReportSnapshot } from "./archive-transfer";

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const localDate = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));

export interface ArchiveTransferReportContract {
  artifactReportId: string;
  transferId: string;
  archiveName: string;
  archiveNameSource: string;
  shootingDate: string;
  payloadFileCount: string;
  payloadBytes: string;
  payloadHumanBytes: string;
  payloadEmptyDirectories: string;
  sourcePath: string;
  finalPath: string;
  startedAt: string;
  completedAt: string;
  hashAlgorithm: string;
  verificationConclusion: string;
  inventoryDigest: string;
  historicalEvidence: string;
  evidenceBoundary: string;
}

export function archiveTransferReportContract(
  snapshot: ArchiveTransferReportSnapshot,
  artifactReportId: string,
): ArchiveTransferReportContract {
  return {
    artifactReportId,
    transferId: snapshot.transferId,
    archiveName: snapshot.archiveName,
    archiveNameSource:
      snapshot.archiveNameSource === "project" ? "项目记录" : "源文件夹名称",
    shootingDate: snapshot.shootingDate,
    payloadFileCount: snapshot.payloadFileCount.toLocaleString("en-US"),
    payloadBytes: snapshot.payloadBytes.toLocaleString("en-US"),
    payloadHumanBytes: snapshot.payloadHumanBytes,
    payloadEmptyDirectories: snapshot.payloadEmptyDirectories.toLocaleString("en-US"),
    sourcePath: snapshot.sourcePath,
    finalPath: snapshot.finalPath,
    startedAt: localDate(snapshot.startedAt),
    completedAt: localDate(snapshot.completedAt),
    hashAlgorithm: snapshot.hashAlgorithm,
    verificationConclusion: snapshot.verificationConclusion,
    inventoryDigest: snapshot.inventoryDigest,
    historicalEvidence: snapshot.historicalEvidence.length
      ? snapshot.historicalEvidence.join("；")
      : "未从关联项目记录中发现需继承的历史异常；这不等于证明历史拍摄完整。",
    evidenceBoundary: snapshot.evidenceBoundary,
  };
}

export function archiveTransferContractDigest(
  contract: ArchiveTransferReportContract,
) {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

const baseStyle = `
  *{box-sizing:border-box}html,body{margin:0;padding:0;background:#f4f1e9;color:#191b1e;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif}
  body{print-color-adjust:exact;-webkit-print-color-adjust:exact}.sheet{background:#fff}.eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#636b72;font-weight:700}
  h1{margin:8px 0 5px;font-size:30px;line-height:1.15}.subtitle{margin:0;color:#5f666c;font-size:13px}.result{display:inline-flex;align-items:center;gap:7px;border-radius:999px;background:#e6f5ea;color:#176236;padding:7px 12px;font-weight:800;font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:#2e9d57}
  .grid{display:grid;gap:10px}.card{border:1px solid #dfe2df;border-radius:12px;padding:13px;background:#fbfbf9}.label{display:block;color:#70777b;font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:5px}.value{font-size:15px;font-weight:750;word-break:break-word}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;word-break:break-all;line-height:1.55}
  .section{margin-top:18px}.section h2{font-size:14px;margin:0 0 9px}.notice{border-left:4px solid #c38c35;background:#fff8e8;padding:11px 13px;font-size:11px;line-height:1.6}.footer{border-top:1px solid #e0e3e1;margin-top:18px;padding-top:10px;color:#6d7478;font-size:9px;display:flex;justify-content:space-between;gap:12px}
`;

const field = (label: string, value: string, mono = false) => `
  <div class="card"><span class="label">${escapeHtml(label)}</span><div class="value${mono ? " mono" : ""}">${escapeHtml(value)}</div></div>`;

function contractMeta(contract: ArchiveTransferReportContract) {
  return `${escapeHtml(JSON.stringify(contract))}`;
}

export function buildArchiveTransferDetailHtml(
  snapshot: ArchiveTransferReportSnapshot,
  artifactReportId: string,
) {
  const data = archiveTransferReportContract(snapshot, artifactReportId),
    digest = archiveTransferContractDigest(data);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${baseStyle}
    @page{size:A4;margin:12mm}.sheet{width:100%;min-height:100vh;padding:4px}.hero{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:10px 0 18px;border-bottom:2px solid #1c2023}.grid.summary{grid-template-columns:repeat(3,1fr);margin-top:15px}.grid.paths{grid-template-columns:1fr}.grid.audit{grid-template-columns:repeat(2,1fr)}
  </style></head><body><main class="sheet" data-report-kind="detail" data-contract-digest="${digest}" data-contract="${contractMeta(data)}">
    <header class="hero"><div><div class="eyebrow">Kocpy · NAS ARCHIVE TRANSFER</div><h1>${escapeHtml(data.archiveName)}</h1><p class="subtitle">归档名来源：${escapeHtml(data.archiveNameSource)} · 拍摄日期：${escapeHtml(data.shootingDate)}</p></div><div class="result"><span class="dot"></span>逐文件回读${escapeHtml(data.verificationConclusion)}</div></header>
    <section class="grid summary">${field("文件数", data.payloadFileCount)}${field("精确字节", data.payloadBytes)}${field("人类可读容量", data.payloadHumanBytes)}${field("空目录", data.payloadEmptyDirectories)}${field("校验算法", data.hashAlgorithm)}${field("报告 ID", data.artifactReportId, true)}</section>
    <section class="section"><h2>实际路径</h2><div class="grid paths">${field("源项目文件夹", data.sourcePath, true)}${field("实际最终 NAS 目标", data.finalPath, true)}</div></section>
    <section class="section"><h2>执行与证据</h2><div class="grid audit">${field("开始时间", data.startedAt)}${field("完成时间", data.completedAt)}${field("转存任务 ID", data.transferId, true)}${field("源范围快照 SHA-256", data.inventoryDigest, true)}</div></section>
    <section class="section"><h2>继承的历史证据</h2><div class="notice">${escapeHtml(data.historicalEvidence)}</div></section>
    <section class="section"><h2>证据边界</h2><div class="notice">${escapeHtml(data.evidenceBoundary)}</div></section>
    <footer class="footer"><span>Kocpy 归档转存事实快照</span><span>合同 SHA-256 ${digest}</span></footer>
  </main></body></html>`;
}

export function buildArchiveTransferSummaryHtml(
  snapshot: ArchiveTransferReportSnapshot,
  artifactReportId: string,
) {
  const data = archiveTransferReportContract(snapshot, artifactReportId),
    digest = archiveTransferContractDigest(data);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${baseStyle}
    html,body{width:1920px;height:1080px;overflow:hidden}.sheet{width:1920px;height:1080px;padding:76px 86px;background:linear-gradient(145deg,#faf8f1 0%,#fff 55%,#edf4ee 100%)}.hero{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1e2427;padding-bottom:30px}.eyebrow{font-size:18px}h1{font-size:62px;margin-top:15px}.subtitle{font-size:23px}.result{font-size:25px;padding:15px 22px}.dot{width:13px;height:13px}.grid.summary{grid-template-columns:repeat(4,1fr);margin-top:34px;gap:18px}.card{padding:22px;border-radius:18px}.label{font-size:14px}.value{font-size:25px}.paths{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.paths .value{font-size:17px;line-height:1.55}.section{margin-top:26px}.section h2{font-size:19px}.notice{font-size:17px;line-height:1.5}.footer{position:absolute;left:86px;right:86px;bottom:50px;font-size:14px}
  </style></head><body><main class="sheet" data-report-kind="summary" data-contract-digest="${digest}" data-contract="${contractMeta(data)}">
    <header class="hero"><div><div class="eyebrow">Kocpy · NAS ARCHIVE TRANSFER</div><h1>${escapeHtml(data.archiveName)}</h1><p class="subtitle">${escapeHtml(data.shootingDate)} · 名称来自${escapeHtml(data.archiveNameSource)}</p></div><div class="result"><span class="dot"></span>${escapeHtml(data.hashAlgorithm)} 独立回读${escapeHtml(data.verificationConclusion)}</div></header>
    <section class="grid summary">${field("文件数", data.payloadFileCount)}${field("精确字节", data.payloadBytes)}${field("容量", data.payloadHumanBytes)}${field("报告 ID", data.artifactReportId, true)}</section>
    <section class="paths">${field("源", data.sourcePath, true)}${field("实际最终 NAS 目标", data.finalPath, true)}</section>
    <section class="section"><h2>时间与范围</h2><div class="notice">开始 ${escapeHtml(data.startedAt)}　完成 ${escapeHtml(data.completedAt)}　空目录 ${escapeHtml(data.payloadEmptyDirectories)}<br>${escapeHtml(data.evidenceBoundary)}</div></section>
    <footer class="footer"><span>任务 ${escapeHtml(data.transferId)}</span><span>范围快照 ${escapeHtml(data.inventoryDigest)}</span><span>合同 ${digest}</span></footer>
  </main></body></html>`;
}
