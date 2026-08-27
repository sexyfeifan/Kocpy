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
      <td>${formatBytes(d.copiedBytes ?? (d.verified ? task.totalBytes : d.bytesWritten))}<small style="display:block;color:#96919d;margin-top:2px">本次写入 ${formatBytes(d.bytesWritten)}</small></td>
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
  .file-table.with-thumbnails th:nth-child(1) { width: 24%; }
  .file-table.with-thumbnails th:nth-child(2) { width: 11%; }
  .file-table.with-thumbnails th:nth-child(3) { width: 34%; }
  .file-table.with-thumbnails th:nth-child(4) { width: 16%; }
  .file-table.with-thumbnails th:nth-child(5) { width: 15%; }
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
    <p>VERIFIED MEDIA TRANSFER REPORT · v0.0.4</p>
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
    <thead><tr><th>目的地路径</th><th>已保存 / 本次写入</th><th>校验状态</th></tr></thead>
    <tbody>${destRows}</tbody>
  </table>
</div>

<div class="section">
  <h2>文件清单</h2>
  <p style="font-size:10px;color:#777;margin-bottom:12px">本报告记录任务执行时的校验结果，不代表当前磁盘状态。总计 ${task.totalFiles} 个文件，已处理 ${task.completedFiles} 个。</p>
  <table class="file-table${options.includeThumbnails ? " with-thumbnails" : ""}">
    <thead><tr><th>文件路径</th><th>大小</th><th>源校验值</th><th>校验结果</th>${options.includeThumbnails ? "<th>首帧缩略图</th>" : ""}</tr></thead>
    <tbody>${fileRows}</tbody>
  </table>
</div>

<div class="footer">Kocpy · 本地优先的素材备份工作台 · 报告编号 ${esc(task.id.slice(0, 12).toUpperCase())}</div>

</body>
</html>`;

  return Buffer.from(html, "utf-8");
}

export async function generateDailyReport(tasks: BackupTask[], shootingDate: string, projectName = "全部项目"): Promise<Buffer> {
  const safeTasks = tasks.filter((t) => t.fileRecords.length > 0);
  const files = safeTasks.reduce((n, t) => n + t.totalFiles, 0), bytes = safeTasks.reduce((n, t) => n + t.totalBytes, 0);
  const rows = safeTasks.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc((t.devices || []).join(" / ") || "-")}</td><td>${t.totalFiles}</td><td>${formatBytes(t.totalBytes)}</td><td style="color:${t.status === "completed" ? "#21b76b" : "#d9545d"}">${t.status === "completed" ? "✓ 全部通过" : `⚠ ${esc(t.errorMessage || "需处理")}`}</td></tr>`).join("");
  const destinationRows = safeTasks.flatMap((t) => t.destinations.map((d) => `<tr><td>${esc(t.name)}</td><td>${esc(d.volumeName || d.label)}</td><td>${esc(d.resolvedPath || d.path)}</td><td>${d.verified ? "✓ 通过" : `✗ ${esc(d.error || "未通过")}`}</td></tr>`)).join("");
  return Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{font-family:-apple-system,"PingFang SC",sans-serif;color:#24212c;padding:30px;background:#f3f1f6;font-size:12px}.cover{padding:30px;border-radius:18px;color:white;background:linear-gradient(135deg,#111216,#332b54);display:flex;justify-content:space-between}.cover h1{font-size:27px;margin:0}.cover p{color:#aaa4b8}.date{font-size:18px;color:#b5a6ff}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.cards div,.section{background:white;border:1px solid #e8e5ed;border-radius:12px;padding:18px}.cards strong{display:block;font-size:21px}.cards span{font-size:9px;color:#8b8593}.section{margin-top:14px}.section h2{font-size:12px;color:#77717e;border-bottom:1px solid #eee;padding-bottom:10px}table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#282331;color:white;text-align:left;padding:9px}td{padding:9px;border-bottom:1px solid #eee;overflow-wrap:anywhere}tr{break-inside:avoid}@media print{body{padding:0;background:white}}</style></head><body><div class="cover"><div><h1>Kocpy · 拍摄日汇总</h1><p>${esc(projectName)} · VERIFIED MEDIA DAY REPORT</p></div><div class="date">${esc(shootingDate)}</div></div><div class="cards"><div><strong>${safeTasks.length}</strong><span>BACKUPS / 备份任务</span></div><div><strong>${files}</strong><span>FILES / 文件</span></div><div><strong>${formatBytes(bytes)}</strong><span>MEDIA / 素材总量</span></div></div><div class="section"><h2>任务结论</h2><table><thead><tr><th>任务</th><th>机位</th><th>文件</th><th>大小</th><th>结论</th></tr></thead><tbody>${rows}</tbody></table></div><div class="section"><h2>目的地与校验</h2><table><thead><tr><th>任务</th><th>磁盘</th><th>路径</th><th>状态</th></tr></thead><tbody>${destinationRows}</tbody></table></div></body></html>`, "utf8");
}
