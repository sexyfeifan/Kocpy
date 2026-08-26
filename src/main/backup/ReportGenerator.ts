import * as fs from "fs";
import type { BackupTask } from "../types";
import { formatBytes } from "../report-builder";

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function generateReport(
  task: BackupTask,
  options: { includeThumbnails?: boolean } = {},
): Promise<Buffer> {
  const statusLabel =
    task.status === "completed"
      ? "备份成功"
      : task.status === "failed"
        ? "备份失败"
        : "部分完成";
  const statusColor =
    task.status === "completed"
      ? "#22c55e"
      : task.status === "failed"
        ? "#ef4444"
        : "#f59e0b";

  const duration =
    task.startedAt && task.completedAt
      ? formatDuration(task.completedAt - task.startedAt)
      : "-";

  const destRows = task.destinations
    .map(
      (d) => `
    <tr>
      <td>${esc(d.resolvedPath || d.path)}</td>
      <td>${formatBytes(d.bytesWritten)}</td>
      <td style="color:${d.verified ? "#22c55e" : d.error ? "#ef4444" : "#888"}">
        ${d.verified ? "✓ 通过" : d.error ? `✗ ${esc(d.error)}` : "未知"}
      </td>
    </tr>`,
    )
    .join("");

  const fileRows = (
    await Promise.all(
      task.fileRecords.map(async (f) => {
        const allOk = f.destinations.every((d) => d.verified);
        let thumbCell = "";
        if (options.includeThumbnails && f.thumbnailPath) {
          try {
            const b64 = fs.readFileSync(f.thumbnailPath).toString("base64");
            thumbCell = `<td style="padding:4px 10px"><img src="data:image/jpeg;base64,${b64}" style="height:48px;width:auto;border-radius:4px;display:block" /></td>`;
          } catch {
            thumbCell = "<td></td>";
          }
        } else if (options.includeThumbnails) {
          thumbCell = "<td></td>";
        }
        return `
    <tr>
      <td>${esc(f.relativePath)}</td>
      <td>${formatBytes(f.size)}</td>
      <td class="mono">${esc(f.srcChecksum)}</td>
      <td style="color:${allOk ? "#22c55e" : "#ef4444"}">${allOk ? "✓ 全部通过" : "✗ 校验失败"}</td>
      ${thumbCell}
    </tr>`;
      }),
    )
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kocpy 备份报告 — ${esc(task.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    font-size: 13px;
    color: #1a1a1a;
    background: #f1f0f5;
    padding: 32px;
  }
  .header {
    background: linear-gradient(135deg, #111216 0%, #242033 62%, #483d78 140%);
    color: #fff;
    padding: 24px 28px;
    border-radius: 18px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 24px;
  }
  .header h1 { font-size: 28px; font-weight: 700; letter-spacing: -1px; }
  .header p { font-size: 11px; color: #888; margin-top: 4px; }
  .badge {
    padding: 6px 14px;
    border-radius: 6px;
    font-weight: 600;
    font-size: 12px;
    color: #fff;
    background: ${statusColor};
    white-space: nowrap;
    margin-top: 4px;
  }
  .summary { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:16px; }
  .summary div { background:#fff; border-radius:12px; padding:16px; border:1px solid #eae8ef; }
  .summary strong { display:block; font-size:17px; color:#24202d; }
  .summary span { display:block; margin-top:7px; color:#8a8590; font-size:9px; letter-spacing:.05em; }
  .section { background: #fff; border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; border:1px solid #eae8ef; }
  .section h2 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    border-bottom: 1px solid #eee;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }
  .info-grid { display: grid; grid-template-columns: 140px 1fr; row-gap: 8px; }
  .info-grid .label { color: #888; }
  .info-grid .value { color: #1a1a1a; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
  td:nth-child(2), td:last-child { white-space: nowrap; }
  .file-table th:nth-child(1) { width: 29%; }
  .file-table th:nth-child(2) { width: 14%; }
  .file-table th:nth-child(3) { width: 42%; }
  .file-table th:nth-child(4) { width: 15%; }
  .file-table .mono { font-size: 9px; overflow-wrap: anywhere; }
  .dest-table th:first-child { width: 62%; }
  .dest-table td:last-child { white-space: normal; }
  th {
    background: #272330;
    color: #fff;
    padding: 8px 10px;
    text-align: left;
    font-weight: 600;
  }
  td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; word-break: break-all; }
  tr:nth-child(even) td { background: #fafafa; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  .mono { font-family: "SF Mono", "Menlo", monospace; }
  .footer { text-align: center; font-size: 11px; color: #aaa; margin-top: 24px; }
  @media print {
    body { background: #fff; padding: 0; }
    .section { box-shadow: none; }
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Kocpy</h1>
    <p>VERIFIED MEDIA TRANSFER REPORT · v0.0.1</p>
    <p style="margin-top:8px;font-size:12px;color:#aaa">生成时间：${new Date().toLocaleString("zh-CN")}</p>
  </div>
  <div class="badge">${statusLabel}</div>
</div>

<div class="summary">
  <div><strong>${task.totalFiles}</strong><span>FILES / 文件</span></div>
  <div><strong>${formatBytes(task.totalBytes)}</strong><span>SOURCE / 源数据</span></div>
  <div><strong>${task.destinations.length}</strong><span>COPIES / 目的地</span></div>
  <div><strong>${duration}</strong><span>DURATION / 总用时</span></div>
</div>

<div class="section">
  <h2>任务信息</h2>
  <div class="info-grid">
    <span class="label">任务名称</span><span class="value">${esc(task.name)}</span>
    <span class="label">任务编号</span><span class="value">${esc(task.id)}</span>
    ${task.errorMessage ? `<span class="label">异常说明</span><span class="value">${esc(task.errorMessage)}</span>` : ""}
    <span class="label">源路径</span><span class="value">${esc(task.sourcePath)}</span>
    <span class="label">机位</span><span class="value">${esc((task.devices || []).join(" / ") || "-")}</span>
    <span class="label">哈希算法</span><span class="value">${task.hashAlgorithm.toUpperCase()}</span>
    <span class="label">总文件数</span><span class="value">${task.totalFiles} 个</span>
    <span class="label">总数据量</span><span class="value">${formatBytes(task.totalBytes)}</span>
    <span class="label">开始时间</span><span class="value">${task.startedAt ? new Date(task.startedAt).toLocaleString("zh-CN") : "-"}</span>
    <span class="label">完成时间</span><span class="value">${task.completedAt ? new Date(task.completedAt).toLocaleString("zh-CN") : "-"}</span>
    <span class="label">耗时</span><span class="value">${duration}</span>
  </div>
</div>

<div class="section">
  <h2>备份目的地</h2>
  <table class="dest-table">
    <thead><tr><th>目的地路径</th><th>写入数据</th><th>校验状态</th></tr></thead>
    <tbody>${destRows}</tbody>
  </table>
</div>

<div class="section">
  <h2>文件清单</h2>
  <p style="font-size:10px;color:#777;margin-bottom:12px">本报告记录任务执行时的校验结果，不代表当前磁盘状态。总计 ${task.totalFiles} 个文件，已处理 ${task.completedFiles} 个。</p>
  <table class="file-table">
    <thead><tr><th>文件路径</th><th>大小</th><th>源校验值</th><th>校验结果</th>${options.includeThumbnails ? "<th>首帧缩略图</th>" : ""}</tr></thead>
    <tbody>${fileRows}</tbody>
  </table>
</div>

<div class="footer">Kocpy · 本地优先的素材备份工作台 · 报告编号 ${esc(task.id.slice(0, 12).toUpperCase())}</div>

</body>
</html>`;

  return Buffer.from(html, "utf-8");
}
