import * as fs from "fs";
import type { BackupTask, ProjectConfig } from "../types";
import { formatBytes } from "../report-builder";
import { projectShootingDates } from "../project-path";
import { projectCellStatus, projectCloseoutSummary, verifiedPhysicalCopyCount } from "../project-closeout";

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}
const performanceLabel = (value?: { average: number; p95: number; peak: number; stalls: number; samples: number }) => value?.samples ? `平均 ${formatBytes(value.average)}/s · P95 ${formatBytes(value.p95)}/s · 峰值 ${formatBytes(value.peak)}/s${value.stalls ? ` · 停顿 ${value.stalls} 次` : ""}` : "样本不足";

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
      <td>${formatBytes(d.copiedBytes ?? (d.verified ? task.totalBytes : d.bytesWritten))}<small style="display:block;color:#96919d;margin-top:2px">本次写入 ${formatBytes(d.bytesWritten)} · ${esc(d.volumeName || "未知卷")} · ${esc(d.volumeUuid || d.volumeId || "无卷标识")}</small><small style="display:block;color:#96919d;margin-top:2px">写入 ${performanceLabel(d.performance)}<br>回读 ${performanceLabel(d.verifyPerformance)}</small></td>
      <td style="color:${d.verified ? "#22c55e" : d.error ? "#ef4444" : "#888"}">
        ${d.verified ? "✓ 通过" : d.error ? `✗ ${esc(d.error)}` : "未知"}
      </td>
    </tr>`,
    )
    .join("");
  const eventRows = (task.faultTimeline || []).slice(-30).map((event) => `<tr><td>${new Date(event.at).toLocaleString("zh-CN")}</td><td>${esc(event.phase)}</td><td style="color:${event.level === "error" ? "#ef4444" : event.level === "warning" ? "#b7791f" : "#555"}">${esc(event.message)}</td></tr>`).join("");

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
    <p>VERIFIED MEDIA TRANSFER REPORT · v0.1.0</p>
    <p style="margin-top:8px;font-size:12px;color:#aaa">生成时间：${new Date().toLocaleString("zh-CN")}</p>
  </div>
  <div class="badge">${statusLabel}</div>
</div>

<div class="summary">
  <div><strong>${task.totalFiles}</strong><span>FILES / 文件</span></div>
  <div><strong>${formatBytes(task.totalBytes)}</strong><span>SOURCE / 源数据</span></div>
  <div><strong>${verifiedPhysicalCopyCount(task)} / ${task.destinations.length}</strong><span>PHYSICAL COPIES / 物理独立副本</span></div>
  <div><strong>${duration}</strong><span>DURATION / 总用时</span></div>
</div>

${eventRows ? `<div class="section"><h2>任务事件时间线</h2><table><thead><tr><th>时间</th><th>阶段</th><th>事件</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : ""}

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
    <span class="label">源哈希读取</span><span class="value">${performanceLabel(task.sourceHashPerformance)}</span>
    <span class="label">源分发读取</span><span class="value">${performanceLabel(task.sourceCopyReadPerformance)}</span>
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

export async function generateProjectReport(project: ProjectConfig, tasks: BackupTask[]): Promise<Buffer> {
  const dates = projectShootingDates(project.shootingDateStart || project.shootingDate || "", project.shootingDateEnd || project.shootingDateStart || project.shootingDate || "");
  const devices = [...new Set([...project.devices, ...tasks.flatMap((task) => task.devices || [])])];
  const totalFiles = tasks.reduce((sum, task) => sum + task.totalFiles, 0), totalBytes = tasks.reduce((sum, task) => sum + task.totalBytes, 0);
  const closeout = projectCloseoutSummary(project, tasks, dates);
  const completed = tasks.filter((task) => task.status === "completed" && verifiedPhysicalCopyCount(task) >= (project.requiredCopies || 2)).length;
  const matrixRows = dates.flatMap((shootingDate) => devices.map((device) => {
    const cell = projectCellStatus(project, tasks, shootingDate, device), rows = cell.rows;
    const files = rows.reduce((sum, task) => sum + task.totalFiles, 0), size = rows.reduce((sum, task) => sum + task.totalBytes, 0);
    return `<tr><td>${esc(shootingDate)}</td><td>${esc(device)}</td><td>${rows.length}</td><td>${files}</td><td>${formatBytes(size)}</td><td class="${cell.complete ? "ok" : rows.length ? "warn" : "muted"}">${cell.label}</td></tr>`;
  })).join("");
  const dailyRows = dates.map((shootingDate) => { const rows = tasks.filter((task) => task.shootingDate === shootingDate); return `<tr><td>${shootingDate}</td><td>${rows.length}</td><td>${rows.reduce((sum, task) => sum + task.totalFiles, 0)}</td><td>${formatBytes(rows.reduce((sum, task) => sum + task.totalBytes, 0))}</td></tr>`; }).join("");
  const deviceRows = devices.map((device) => { const rows = tasks.filter((task) => task.devices.includes(device)), size = rows.reduce((sum, task) => sum + task.totalBytes, 0); return `<tr><td>${esc(device)}</td><td>${rows.length}</td><td>${rows.reduce((sum, task) => sum + task.totalFiles, 0)}</td><td>${formatBytes(size)}</td><td>${totalBytes ? (size / totalBytes * 100).toFixed(1) : 0}%</td></tr>`; }).join("");
  const taskRows = [...tasks].sort((a, b) => (a.shootingDate || "").localeCompare(b.shootingDate || "") || (a.startedAt || 0) - (b.startedAt || 0)).map((task) => { const copies = verifiedPhysicalCopyCount(task), safe = task.status === "completed" && copies >= (project.requiredCopies || 2); return `<tr><td>${esc(task.shootingDate || "-")}</td><td>${esc((task.devices || []).join(" / ") || "-")}${task.cameraPosition ? ` · ${esc(task.cameraPosition)}` : ""}</td><td>${esc(task.name)}</td><td>${task.totalFiles}</td><td>${formatBytes(task.totalBytes)}</td><td class="${safe ? "ok" : "warn"}">${safe ? `✓ ${copies} 份物理独立副本` : `⚠ ${esc(task.errorMessage || `${copies} 份物理独立副本，未达到要求`)}`}</td></tr>`; }).join("");
  const destinationRows = tasks.flatMap((task) => task.destinations.map((destination) => `<tr><td>${esc(task.name)}</td><td>${esc(destination.volumeName || destination.label)}</td><td>${esc(destination.resolvedPath || destination.path)}</td><td class="${destination.verified ? "ok" : "warn"}">${destination.verified ? "✓ 通过" : `✗ ${esc(destination.error || "未通过")}`}</td></tr>`)).join("");
  const fileRows = tasks.flatMap((task) => task.fileRecords.map((file) => `<tr><td>${esc(task.shootingDate || "-")}</td><td>${esc((task.devices || []).join(" / ") || "-")}</td><td>${esc(task.name)}</td><td>${esc(file.relativePath)}</td><td>${formatBytes(file.size)}</td><td class="${file.destinations.every((destination) => destination.verified) ? "ok" : "warn"}">${file.destinations.filter((destination) => destination.verified).length} / ${file.destinations.length} 通过</td></tr>`)).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{font-family:-apple-system,"PingFang SC",sans-serif;color:#24212c;padding:28px;background:#f5f3f7;font-size:11px}.cover{padding:28px;border-radius:16px;color:#fff;background:linear-gradient(135deg,#6d5ee8,#9a88ff);display:flex;justify-content:space-between}.cover h1{margin:0;font-size:25px}.cover p{margin:8px 0 0;color:#eeeaff}.period{font-size:15px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.summary div,.section{background:#fff;border:1px solid #e7e2ee;border-radius:11px;padding:15px}.summary strong{display:block;font-size:19px}.summary span{display:block;color:#8b8493;font-size:8px;margin-top:5px}.section{margin-top:12px}.section h2{font-size:12px;margin:0 0 11px;padding-bottom:9px;border-bottom:1px solid #eee9f2}table{width:100%;border-collapse:collapse;table-layout:fixed}th{padding:8px;background:#eee9ff;color:#514783;text-align:left}td{padding:7px 8px;border-bottom:1px solid #eee;overflow-wrap:anywhere}tr{break-inside:avoid}.ok{color:#188b58}.warn{color:#bd4e5a}.muted{color:#999}.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}.footer{text-align:center;color:#999;margin-top:18px}@page{size:A4;margin:12mm}@media print{body{padding:0;background:#fff}.section{break-inside:auto}}</style></head><body><div class="cover"><div><h1>Kocpy · 项目完整报告</h1><p>${esc(project.name)} · PROJECT MEDIA REPORT</p></div><div class="period">${esc(project.shootingDateStart || "-")} — ${esc(project.shootingDateEnd || project.shootingDateStart || "-")}<br>报告编号 ${esc(project.id.slice(0, 12).toUpperCase())}</div></div><div class="summary"><div><strong>${tasks.length}</strong><span>BACKUPS / 备份任务</span></div><div><strong>${completed} / ${tasks.length}</strong><span>SAFE TASKS / 达到副本要求</span></div><div><strong>${totalFiles}</strong><span>FILES / 文件</span></div><div><strong>${formatBytes(totalBytes)}</strong><span>MEDIA / 项目素材</span></div></div><div class="section"><h2>项目收工结论 · ${closeout.complete} / ${closeout.total} 个日期设备单元完成</h2><p class="${closeout.pending.length ? "warn" : "ok"}">${closeout.pending.length ? `仍有 ${closeout.pending.length} 个单元待处理` : "全部拍摄日和设备均满足收工要求"}</p></div><div class="section"><h2>日期 × 设备素材完成情况</h2><table><thead><tr><th>拍摄日期</th><th>设备 / 机位</th><th>素材卷</th><th>文件</th><th>素材量</th><th>收工状态</th></tr></thead><tbody>${matrixRows}</tbody></table></div><div class="split"><div class="section"><h2>每日素材趋势</h2><table><thead><tr><th>日期</th><th>素材卷</th><th>文件</th><th>素材量</th></tr></thead><tbody>${dailyRows}</tbody></table></div><div class="section"><h2>设备素材占比</h2><table><thead><tr><th>设备</th><th>素材卷</th><th>文件</th><th>素材量</th><th>占比</th></tr></thead><tbody>${deviceRows}</tbody></table></div></div><div class="section"><h2>全部备份任务</h2><table><thead><tr><th>日期</th><th>设备 / 机位</th><th>素材卷</th><th>文件</th><th>素材量</th><th>结论</th></tr></thead><tbody>${taskRows}</tbody></table></div><div class="section"><h2>目的地与独立校验</h2><table><thead><tr><th>素材卷</th><th>磁盘</th><th>最终路径</th><th>校验</th></tr></thead><tbody>${destinationRows}</tbody></table></div><div class="section"><h2>完整文件明细</h2><table><thead><tr><th>日期</th><th>设备</th><th>素材卷</th><th>文件路径</th><th>大小</th><th>副本校验</th></tr></thead><tbody>${fileRows}</tbody></table></div><div class="footer">Kocpy · @sexyfeifan · 生成时间 ${new Date().toLocaleString("zh-CN")}</div></body></html>`;
  return Buffer.from(html, "utf8");
}
