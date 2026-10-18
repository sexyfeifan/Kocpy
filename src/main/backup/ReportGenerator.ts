import * as fs from "fs";
import { captureTimeContext, formatEvidenceTime, timeContextSummary, projectTimeRulesSummary } from "../../common/time-context";
import { portableProjectReportSection, portableReferenceProjectReport } from "../portable-project-report";
import type {
  BackupTask,
  ProjectConfig,
  ReportContextSnapshot,
} from "../types";
import { formatBytes } from "../report-builder";
import { projectDates, shootingDateKey } from "../../common/shooting-dates";
import { APP_VERSION } from "../../common/version";
import { copyEvidenceSummary } from "../../common/copy-evidence";
import { taskDateContribution } from "../../common/date-allocation";
import { taskTrustState, savedDestinationBytes, taskHasPartialSelection } from "../../common/task-trust";
import { backupSelectionSummary } from "../../common/backup-selection";
import { projectFileDateRecords } from "../../common/shooting-day-records";
import {
  projectCellStatus,
  projectCloseoutSummary,
  projectDaySummary,
  projectDeviceCells,
  taskMeetsCopyRequirement,
} from "../project-closeout";

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}
const performanceLabel = (value?: {
  average: number;
  p95: number;
  peak: number;
  stalls: number;
  samples: number;
}) =>
  value?.samples
    ? `平均 ${formatBytes(value.average)}/s · P95 ${formatBytes(value.p95)}/s · 峰值 ${formatBytes(value.peak)}/s${value.stalls ? ` · 停顿 ${value.stalls} 次` : ""}`
    : "样本不足";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function devicePositionLabel(task: BackupTask): string {
  const device = (task.devices || []).join(" / ") || "-";
  return task.cameraPosition ? `${device} · ${task.cameraPosition}` : device;
}

function selectionReportText(task: BackupTask): string {
  const plan = task.selection;
  if (!plan) return "";
  const scope = backupSelectionSummary(plan);
  return `完整源扫描 ${plan.sourceFiles.length} 个文件 / ${formatBytes(plan.sourceScope.includedBytes)}；本次选择 ${scope.includedFiles} 个 / ${formatBytes(scope.includedBytes)}；未复制 ${scope.excludedFiles} 个 / ${formatBytes(scope.excludedBytes)}（历史已验证 ${scope.historicalFiles} 个，未保护 ${scope.unprotectedFiles} 个）；确认人 ${plan.operator}；选择日期 ${plan.selectedDates.join("、") || "仅保留必需和未知日期内容"}`;
}

function summaryTaskDetailRow(task: BackupTask, columns: number): string {
  const trust = taskTrustState(task);
  return `<tr class="task-detail"><td colspan="${columns}">${task.selection ? `<p><strong>备份范围与确认</strong> · ${esc(selectionReportText(task))}</p>` : ""}<p>${esc(timeContextSummary(task.timeContext))}</p><p>开始 ${task.startedAt ? esc(formatEvidenceTime(task.startedAt, task.timeContext)) : "未记录"}；完成 ${task.completedAt ? esc(formatEvidenceTime(task.completedAt, task.timeContext)) : "未记录"}</p><p><strong>下一步</strong> · ${esc(trust.nextStep)}</p></td></tr>`;
}

const summaryTableStyles = `
  td, th { vertical-align: top; line-height: 1.55; }
  thead { display: table-header-group; }
  .task-group { break-inside: avoid; }
  .task-detail td { background: #f6f4f9; padding: 10px 12px 12px; color: #4e465d; border-bottom: 2px solid #e5dfed; }
  .task-detail p { margin: 0; overflow-wrap: anywhere; }
  .task-detail p + p { margin-top: 6px; }
  .task-detail strong { color: #3a3345; }
  .daily-task-table th:nth-child(1) { width: 16%; }
  .daily-task-table th:nth-child(2) { width: 20%; }
  .daily-task-table th:nth-child(3) { width: 10%; }
  .daily-task-table th:nth-child(4) { width: 7%; }
  .daily-task-table th:nth-child(5) { width: 13%; }
  .daily-task-table th:nth-child(6) { width: 34%; }
  .daily-destination-table th:nth-child(1) { width: 12%; }
  .daily-destination-table th:nth-child(2) { width: 17%; }
  .daily-destination-table th:nth-child(3) { width: 12%; }
  .daily-destination-table th:nth-child(4) { width: 46%; }
  .daily-destination-table th:nth-child(5) { width: 13%; }
  .split td:first-child { white-space: normal; overflow-wrap: anywhere; }
  .split th, .split td { padding-left: 6px; padding-right: 6px; }
  .split .section:first-child th:first-child { width: 30%; }
  .split .section:first-child th:nth-child(2) { width: 18%; }
  .split .section:first-child th:nth-child(3) { width: 20%; }
  .split .section:first-child th:nth-child(4) { width: 32%; }
  .split .section:last-child th:first-child { width: 28%; }
  .split .section:last-child th:nth-child(2) { width: 18%; }
  .split .section:last-child th:nth-child(3) { width: 14%; }
  .split .section:last-child th:nth-child(4) { width: 22%; }
  .split .section:last-child th:nth-child(5) { width: 18%; }
  .file-detail-table th:nth-child(1) { width: 13%; }
  .file-detail-table th:nth-child(2) { width: 15%; }
  .file-detail-table th:nth-child(3) { width: 18%; }
  .file-detail-table th:nth-child(4) { width: 32%; }
  .file-detail-table th:nth-child(5) { width: 9%; }
  .file-detail-table th:nth-child(6) { width: 13%; }
  @media print { .section { border: 0; border-radius: 0; padding: 0; } .section h2 { break-after: avoid; } }
`;

function selectionReportSection(task: BackupTask): string {
  const plan = task.selection;
  if (!plan) return "";
  const sourceFiles = new Map(plan.sourceFiles.map((file) => [file.relativePath, file]));
  const groups = new Map(plan.groups.map((group) => [group.id, group]));
  const exclusions = plan.excludedFiles.map((file) => {
    const group = groups.get(file.groupId);
    const date = plan.assignedDates[file.groupId] || group?.suggestedDate || "未知";
    const history = file.historyEvidence.map((item) => `${item.path}（任务 ${item.taskId}，${formatEvidenceTime(item.checkedAt, plan.timeContext)}）`).join("；");
    return `<tr><td>${esc(file.relativePath)}</td><td>${esc(date)}</td><td>${formatBytes(sourceFiles.get(file.relativePath)?.size || 0)}</td><td>${file.reason === "history-verified" ? "历史副本已读取核对；未复制到本次目标" : "用户未选；未证明已受保护"}${history ? `<br>${esc(history)}` : ""}</td></tr>`;
  }).join("");
  return `<div class="section"><h2>备份范围选择与未复制记录</h2><p>${esc(selectionReportText(task))}</p><p>确认时间 ${esc(formatEvidenceTime(plan.confirmedAt, plan.timeContext))} · 范围摘要 ${esc(plan.digest)}</p><p>${taskHasPartialSelection(task) ? "本次是选定范围备份，不是整卡完整副本。历史已验证仅表示预检时另一个位置的副本依据，不代表此刻在线，也不计作本次目标中的文件。不得据此格式化源素材卡。" : "本次选择纳入了全部可读取文件。仍须结合源扫描排除及项目独立副本要求判断。"} 源扫描无法读取的内容单独列于范围排除记录；原外部清单保持原样。</p>${exclusions ? `<table><thead><tr><th>未复制相对路径</th><th>归属日期</th><th>容量</th><th>原因与历史依据</th></tr></thead><tbody>${exclusions}</tbody></table>` : ""}</div>`;
}

export function dailyReportContribution(
  task: BackupTask,
  shootingDate: string,
) {
  const allocated = taskDateContribution(task, shootingDate);
  if (allocated) return allocated;
  if (shootingDateKey(task.shootingDate)) return undefined;
  const legacyDate = new Date(
    task.completedAt || task.createdAt || 0,
  ).toLocaleDateString("sv-SE");
  if (legacyDate !== shootingDate) return undefined;
  return {
    shootingDate,
    files: task.totalFiles,
    bytes: task.totalBytes,
    scope: task.selection ? "selected-scope" as const : "full-card" as const,
    pendingAllocation: Boolean(task.selection),
    pendingGroups: task.selection ? 1 : 0,
  };
}

export function resolvedReportContext(
  task: BackupTask,
  project?: Pick<ProjectConfig, "id" | "name">,
): ReportContextSnapshot {
  if (task.reportContext) return task.reportContext;
  return {
    capturedAt: task.completedAt || task.createdAt || Date.now(),
    projectId: task.projectId || project?.id,
    projectName: project?.name,
    projectNameSource: project?.name
      ? "legacy-project-lookup"
      : "unassigned",
    shootingDate: task.shootingDate || undefined,
    shootingDateSource: task.shootingDate
      ? "legacy-task-field"
      : "unrecorded",
  };
}

const projectLabel = (task: BackupTask) =>
  task.reportContext?.projectName ||
  task.reportContext?.projectId ||
  task.projectId ||
  "未归属项目";

export async function generateReport(
  task: BackupTask,
  options: {
    includeThumbnails?: boolean;
    project?: Pick<ProjectConfig, "id" | "name">;
    generatedAt?: number;
  } = {},
): Promise<Buffer> {
  const trust = taskTrustState(task);
  const context = resolvedReportContext(task, options.project);
  const generatedAt = options.generatedAt ?? Date.now();
  const statusLabel = trust.label;
  const statusColor =
    trust.status === "completed"
      ? "#22c55e"
      : trust.status === "unverified"
        ? "#f59e0b"
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
      <td class="destination-amount"><strong>${formatBytes(savedDestinationBytes(task, d))}</strong><small>本次写入 ${formatBytes(d.bytesWritten)}</small><small>${esc(d.volumeName || "未知卷")}</small><small class="identifier">${esc(d.volumeUuid || d.volumeId || "无卷标识")}</small><small>写入 ${performanceLabel(d.performance)}</small><small>回读 ${performanceLabel(d.verifyPerformance)}</small></td>
      <td style="color:${d.verified ? "#22c55e" : d.error ? "#ef4444" : "#888"}">
        ${d.verified ? "✓ 通过" : d.error ? `✗ ${esc(d.error)}` : "未知"}
      </td>
    </tr>`,
    )
    .join("");
  const eventRows = (task.faultTimeline || [])
    .slice(-30)
    .map(
      (event) =>
        `<tr><td>${formatEvidenceTime(event.at, task.timeContext)}</td><td>${esc(event.phase)}</td><td style="color:${event.level === "error" ? "#ef4444" : event.level === "warning" ? "#b7791f" : "#555"}">${esc(event.message)}</td></tr>`,
    )
    .join("");
  const inventory = task.inventoryScope,
    hasUnknownExcludedBytes = inventory?.exclusions.some(
      (item) => item.bytesUnknown,
    ),
    inventoryLabel = taskHasPartialSelection(task)
      ? "用户确认的选定范围 · 不代表整卡完整"
      : inventory
      ? inventory.policy.mode === "complete" && inventory.exclusions.length === 0
        ? `完整文件范围 · ${inventory.policy.version}`
        : `明确过滤范围 · ${inventory.policy.version}`
      : "历史扫描范围 · 不追溯改标完整",
    exclusionLabel = inventory
      ? `${inventory.excludedFiles} 个文件 / ${inventory.excludedDirectories} 个目录 / ${hasUnknownExcludedBytes ? "已知 " : ""}${formatBytes(inventory.excludedBytes)}`
      : `${task.skippedFiles || 0} 项（旧记录未保存精确路径和字节）`,
    exclusionRows = (inventory?.exclusions || [])
      .map((item) => {
        const reason = {
          "hidden-by-user-filter": "用户选择过滤隐藏条目",
          "system-directory": "系统隐藏目录",
          "permission-denied": `无读取权限${item.permissionCode ? `（${item.permissionCode}）` : ""}`,
        }[item.reason];
        return `<tr><td>${esc(item.relativePath)}</td><td>${item.kind === "file" ? "文件" : "目录"}</td><td>${item.bytesUnknown ? "未知" : formatBytes(item.bytes)}</td><td>${esc(reason)}</td></tr>`;
      })
      .join("");

  const fileRows = (
    await Promise.all(
      task.fileRecords.map(async (f) => {
        const allOk =
          f.destinations.length > 0 && f.destinations.every((d) => d.verified);
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
  .snapshot-note { margin:-8px 0 16px;padding:12px 14px;border:1px solid #d9d3e5;border-radius:10px;background:#fbf9ff;color:#5e5668;line-height:1.6; }
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
  .section > p { margin: 8px 0; line-height: 1.65; overflow-wrap: anywhere; }
  .destination-section { break-inside: avoid; }
  .file-section > p { break-after: avoid; }
  .section h2 {
    break-after: avoid;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    border-bottom: 1px solid #eee;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }
  .info-grid { display: grid; grid-template-columns: 140px minmax(0, 1fr); row-gap: 8px; }
  .info-grid .label { color: #888; }
  .info-grid .value { color: #1a1a1a; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
  th, td { min-width: 0; white-space: normal; overflow-wrap: anywhere; word-break: break-word; vertical-align: top; }
  .event-table th:nth-child(1) { width: 18%; }
  .event-table th:nth-child(2) { width: 16%; }
  .event-table th:nth-child(3) { width: 66%; }
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
  th {
    background: #272330;
    color: #fff;
    padding: 8px 10px;
    text-align: left;
    font-weight: 600;
  }
  td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; word-break: break-all; }
  .dest-table { table-layout: fixed; }
  .dest-table th:nth-child(1) { width: 43%; }
  .dest-table th:nth-child(2) { width: 37%; }
  .dest-table th:nth-child(3) { width: 20%; }
  .destination-amount strong { display:block; font-size:13px; margin-bottom:6px; }
  .destination-amount small { display:block; color:#777; line-height:1.55; margin:0; }
  .destination-amount .identifier { font-family:"SF Mono","Menlo",monospace; font-size:8px; overflow-wrap:anywhere; margin-bottom:4px; }
  tr:nth-child(even) td { background: #fafafa; }
  tr { break-inside: avoid; }
  thead { display: table-header-group; }
  .mono { font-family: "SF Mono", "Menlo", monospace; }
  .footer { text-align: center; font-size: 11px; color: #aaa; margin-top: 24px; }
  @page { size: A4; margin: 10mm 8mm; }
  @media print {
    body { background: #fff; padding: 0; }
    /* Cards spanning many pages can clip Chromium's repeated table headers.
       Use flat print sections; keep the decorated cards for HTML viewing. */
    .section { box-shadow: none; border: 0; border-radius: 0; padding: 0; margin-bottom: 20px; }
    .section h2 { padding-top: 12px; }
    .task-info-section, .info-grid { break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Kocpy</h1>
    <p>VERIFIED MEDIA TRANSFER SNAPSHOT · v${APP_VERSION}</p>
    <p style="margin-top:8px;font-size:12px;color:#aaa">生成时间：${formatEvidenceTime(generatedAt, task.timeContext)}</p>
  </div>
  <div class="badge">${statusLabel}</div>
</div>

<div class="snapshot-note"><strong>首次完成时的不可变校验快照</strong> · 下列路径与副本列表记录任务首次完成时的状态；若副本以后迁移或新增，Kocpy 会保留这份原始字节，并在归档变化记录中追踪当前位置，不会把旧路径改写成新路径。</div>

<div class="summary">
  <div><strong>${task.totalFiles}</strong><span>FILES / 文件</span></div>
  <div><strong>${formatBytes(task.totalBytes)}</strong><span>${taskHasPartialSelection(task) ? "SELECTED / 本次选择" : "SOURCE / 源数据"}</span></div>
  <div><strong>${trust.countableCopies}</strong><span>COUNTABLE COPIES / 可计数副本</span></div>
  <div><strong>${duration}</strong><span>DURATION / 总用时</span></div>
</div>

${eventRows ? `<div class="section"><h2>任务事件时间线</h2><table class="event-table"><thead><tr><th>时间</th><th>阶段</th><th>事件</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : ""}

<div class="section task-info-section">
  <h2>任务信息</h2>
  <p><strong>${esc(trust.basis)}</strong> · ${trust.copies.verifiedTargets} 个目标有校验通过记录</p>
  <p>${esc(trust.explanation)} ${esc(trust.nextStep)}</p>
  <p>最近记录：${trust.verifiedAt ? formatEvidenceTime(trust.verifiedAt, task.timeContext) : "未记录完整校验时间"}</p>
  <p>${copyEvidenceSummary(task.destinations).independencePending ? "物理独立性证据不足：旧记录、未知拓扑或不同检查批次不合并计数。重新校验在线目标可更新存储关系。" : "副本计数依据已记录的系统存储关系；不同目录或卷 UUID 不自动代表不同物理磁盘，也不代表机箱、供电或灾备独立。"} 校验完成不等于可以格式化原卡。</p>
  <div class="info-grid">
    <span class="label">任务名称</span><span class="value">${esc(task.name)}</span>
    <span class="label">任务编号</span><span class="value">${esc(task.id)}</span>
    <span class="label">项目名称</span><span class="value">${esc(context.projectName || "未归属项目")}</span>
    <span class="label">项目编号</span><span class="value">${esc(context.projectId || "-")}</span>
    <span class="label">拍摄日期</span><span class="value">${esc(context.shootingDate || "未记录")}</span>
    <span class="label">报告上下文来源</span><span class="value">项目：${esc(context.projectNameSource)} · 日期：${esc(context.shootingDateSource)}</span>
    ${task.errorMessage ? `<span class="label">异常说明</span><span class="value">${esc(task.errorMessage)}</span>` : ""}
    <span class="label">源路径</span><span class="value">${esc(task.sourcePath)}</span>
    <span class="label">设备 / 机位</span><span class="value">${esc(devicePositionLabel(task))}</span>
    <span class="label">哈希算法</span><span class="value">${task.hashAlgorithm.toUpperCase()}</span>
    <span class="label">总文件数</span><span class="value">${task.totalFiles} 个</span>
    <span class="label">总数据量</span><span class="value">${formatBytes(task.totalBytes)}</span>
    <span class="label">备份范围</span><span class="value">${esc(inventoryLabel)}</span>
    <span class="label">扫描策略排除</span><span class="value">${esc(exclusionLabel)}</span>
    <span class="label">开始时间</span><span class="value">${task.startedAt ? formatEvidenceTime(task.startedAt, task.timeContext) : "-"}</span>
    <span class="label">完成时间</span><span class="value">${task.completedAt ? formatEvidenceTime(task.completedAt, task.timeContext) : "-"}</span>
    <span class="label">耗时</span><span class="value">${duration}</span>
    <span class="label">源哈希读取</span><span class="value">${performanceLabel(task.sourceHashPerformance)}</span>
    <span class="label">源分发读取</span><span class="value">${performanceLabel(task.sourceCopyReadPerformance)}</span>
  </div>
</div>

${exclusionRows ? `<div class="section"><h2>扫描策略排除清单</h2><p>以下路径因扫描策略不属于本任务的备份与校验范围，与用户按日期未选择的文件分别记录；已读取的路径、数量、字节和原因已随任务记录持久化。${hasUnknownExcludedBytes ? "存在大小未知的排除条目，汇总字节仅含已知部分；未扫描目录内的文件数量与字节未计入统计。" : ""}</p><table><thead><tr><th>相对路径</th><th>类型</th><th>字节</th><th>原因</th></tr></thead><tbody>${exclusionRows}</tbody></table></div>` : ""}

<div class="section"><h2>时间与拍摄归属</h2><p>${esc(timeContextSummary(task.timeContext))}</p><p>操作时间按冻结的操作时区展示；相机日期仅作线索。拍摄时区参考开始：${task.startedAt ? esc(formatEvidenceTime(task.startedAt, task.timeContext, "shooting")) : "未记录"}</p></div>
${selectionReportSection(task)}

<div class="section destination-section">
  <h2>备份目的地</h2>
  <table class="dest-table">
    <thead><tr><th>目的地路径</th><th>已保存 / 本次写入</th><th>校验状态</th></tr></thead>
    <tbody>${destRows}</tbody>
  </table>
</div>

<div class="section file-section">
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

export async function generateDailyReport(
  tasks: BackupTask[],
  shootingDate: string,
  projectName = "全部项目",
): Promise<Buffer> {
  const safeTasks = tasks
    .map((task) => ({
      task,
      contribution: dailyReportContribution(task, shootingDate),
    }))
    .filter(
      (item): item is {
        task: BackupTask;
        contribution: NonNullable<typeof item.contribution>;
      } => item.task.fileRecords.length > 0 && Boolean(item.contribution),
    );
  const files = safeTasks.reduce(
      (total, item) => total + item.contribution.files,
      0,
    ),
    bytes = safeTasks.reduce(
      (total, item) => total + item.contribution.bytes,
      0,
    );
  const rows = safeTasks
    .map(
      ({ task: t, contribution }) => {
        const trust = taskTrustState(t);
        const scope = taskHasPartialSelection(t)
          ? "选定范围 · 非整卡"
          : contribution.scope === "selected-scope"
            ? `选定范围${contribution.pendingAllocation ? " · 日期归属待确认" : ""}`
          : contribution.scope === "daily-allocation"
          ? `当日分配${contribution.pendingAllocation ? ` · ${contribution.pendingGroups} 组待分配` : ""}`
          : "整卡";
        return `<tbody class="task-group"><tr><td>${esc(projectLabel(t))}</td><td>${esc(t.name)}</td><td>${esc(devicePositionLabel(t))}</td><td>${contribution.files}</td><td>${formatBytes(contribution.bytes)}<br>${scope}</td><td style="color:${trust.status === "completed" ? "#21b76b" : "#d9545d"}">${esc(trust.label)}<br>${trust.countableCopies} 份可计数副本</td></tr>${summaryTaskDetailRow(t, 6)}</tbody>`;
      },
    )
    .join("");
  const destinationRows = safeTasks
    .flatMap(({ task: t }) =>
      t.destinations.map(
        (d) =>
          `<tr><td>${esc(projectLabel(t))}</td><td>${esc(t.name)}</td><td>${esc(d.volumeName || d.label)}</td><td>${esc(d.resolvedPath || d.path)}</td><td>${d.verified ? "✓ 通过" : `✗ ${esc(d.error || "未通过")}`}</td></tr>`,
      ),
    )
    .join("");
  return Buffer.from(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{font-family:-apple-system,"PingFang SC",sans-serif;color:#24212c;padding:30px;background:#f3f1f6;font-size:12px}.cover{padding:30px;border-radius:18px;color:white;background:linear-gradient(135deg,#111216,#332b54);display:flex;justify-content:space-between}.cover h1{font-size:27px;margin:0}.cover p{color:#aaa4b8}.date{font-size:18px;color:#b5a6ff}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}.cards div,.section{background:white;border:1px solid #e8e5ed;border-radius:12px;padding:18px}.cards strong{display:block;font-size:21px}.cards span{font-size:9px;color:#8b8593}.section{margin-top:14px}.section h2{font-size:12px;color:#77717e;border-bottom:1px solid #eee;padding-bottom:10px}table{width:100%;border-collapse:collapse;table-layout:fixed}th{background:#282331;color:white;text-align:left;padding:9px}td{padding:9px;border-bottom:1px solid #eee;overflow-wrap:anywhere}tr{break-inside:avoid}@media print{body{padding:0;background:white}}${summaryTableStyles}</style></head><body><div class="cover"><div><h1>Kocpy · 拍摄日汇总</h1><p>${esc(projectName)} · VERIFIED MEDIA DAY REPORT</p></div><div class="date">${esc(shootingDate)}</div></div><div class="cards"><div><strong>${safeTasks.length}</strong><span>BACKUPS / 备份任务</span></div><div><strong>${files}</strong><span>FILES / 文件</span></div><div><strong>${formatBytes(bytes)}</strong><span>MEDIA / 素材总量</span></div></div><div class="section"><h2>任务结论</h2><table class="daily-task-table"><thead><tr><th>项目</th><th>任务</th><th>机位</th><th>文件</th><th>大小</th><th>结论</th></tr></thead>${rows}</table></div><div class="section"><h2>目的地与校验</h2><table class="daily-destination-table"><thead><tr><th>项目</th><th>任务</th><th>磁盘</th><th>路径</th><th>状态</th></tr></thead><tbody>${destinationRows}</tbody></table></div></body></html>`,
    "utf8",
  );
}

export async function generateProjectReport(
  project: ProjectConfig,
  tasks: BackupTask[],
): Promise<Buffer> {
  if (project.portableHistory?.length && !tasks.length) return Buffer.from(portableReferenceProjectReport(project), "utf8");
  const dates = projectDates(project, tasks);
  const devices = [
    ...new Set([
      ...project.devices,
      ...tasks.flatMap((task) => task.devices || []),
    ]),
  ];
  const totalFiles = tasks.reduce((sum, task) => sum + task.totalFiles, 0),
    totalBytes = tasks.reduce((sum, task) => sum + task.totalBytes, 0);
  const closeout = projectCloseoutSummary(project, tasks, dates);
  const completed = tasks.filter(
    (task) =>
      taskMeetsCopyRequirement(task, project.requiredCopies || 2),
  ).length;
  const matrixRows = dates
    .flatMap((shootingDate) =>
      projectDeviceCells(project, tasks, shootingDate).map(
        ({ device, cameraPosition, label }) => {
          const cell = projectCellStatus(
              project,
              tasks,
              shootingDate,
              device,
              cameraPosition,
            ),
            rows = cell.rows;
          return `<tr><td>${esc(shootingDate)}</td><td>${esc(label)}</td><td>${rows.length}</td><td>${cell.files}</td><td>${formatBytes(cell.bytes)}</td><td class="${cell.complete ? "ok" : rows.length ? "warn" : "muted"}">${cell.statusLabel}</td></tr>`;
        },
      ),
    )
    .join("");
  const dailyRows = dates
    .map((shootingDate) => {
      const summary = projectDaySummary(project, tasks, shootingDate);
      return `<tr><td>${shootingDate}</td><td>${summary.volumes}</td><td>${summary.files}</td><td>${formatBytes(summary.bytes)}</td></tr>`;
    })
    .join("");
  const deviceRows = devices
    .map((device) => {
      const rows = tasks.filter((task) => task.devices.includes(device)),
        size = rows.reduce((sum, task) => sum + task.totalBytes, 0);
      return `<tr><td>${esc(device)}</td><td>${rows.length}</td><td>${rows.reduce((sum, task) => sum + task.totalFiles, 0)}</td><td>${formatBytes(size)}</td><td>${totalBytes ? ((size / totalBytes) * 100).toFixed(1) : 0}%</td></tr>`;
    })
    .join("");
  const taskRows = [...tasks]
    .sort(
      (a, b) =>
        (a.shootingDate || "").localeCompare(b.shootingDate || "") ||
        (a.startedAt || 0) - (b.startedAt || 0),
    )
    .map((task) => {
      const trust = taskTrustState(task), copies = trust.countableCopies,
        safe = taskMeetsCopyRequirement(
          task,
          project.requiredCopies || 2,
        );
      return `<tbody class="task-group"><tr><td>${esc(task.shootingDate || "-")}</td><td>${esc((task.devices || []).join(" / ") || "-")}${task.cameraPosition ? ` · ${esc(task.cameraPosition)}` : ""}</td><td>${esc(task.name)}</td><td>${task.totalFiles}</td><td>${formatBytes(task.totalBytes)}</td><td class="${safe ? "ok" : "warn"}">${esc(trust.label)}<br>${safe ? `✓ ${copies} 份可计数副本` : `⚠ ${copies} 份可计数副本 · 未达到要求`}</td></tr>${summaryTaskDetailRow(task, 6)}</tbody>`;
    })
    .join("");
  const destinationRows = tasks
    .flatMap((task) =>
      task.destinations.map(
        (destination) =>
          `<tr><td>${esc(task.name)}</td><td>${esc(destination.volumeName || destination.label)}</td><td>${esc(destination.resolvedPath || destination.path)}</td><td class="${destination.verified ? "ok" : "warn"}">${destination.verified ? "✓ 通过" : `✗ ${esc(destination.error || "未通过")}`}</td></tr>`,
      ),
    )
    .join("");
  const fileRows = tasks
    .flatMap((task) =>
      projectFileDateRecords(task).map(
        ({ file, shootingDate, dateStatus }) =>
          `<tr><td>${esc(shootingDate || "待确认归属")}${dateStatus === "confirmed-assignment" ? "<br>已确认归属" : dateStatus === "task-date" ? "<br>任务拍摄日" : ""}</td><td>${esc((task.devices || []).join(" / ") || "-")}</td><td>${esc(task.name)}</td><td>${esc(file.relativePath)}</td><td>${formatBytes(file.size)}</td><td class="${file.destinations.every((destination) => destination.verified) ? "ok" : "warn"}">${file.destinations.filter((destination) => destination.verified).length} / ${file.destinations.length} 通过</td></tr>`,
      ),
    )
    .join("");
  const closeoutMessage = closeout.pending.length
    ? `有 ${closeout.pending.length} 个单元明确需要处理${closeout.unconfirmed.length ? `，另有 ${closeout.unconfirmed.length} 个单元待确认是否使用` : ""}`
    : closeout.unconfirmed.length
      ? `没有明确缺失；仍有 ${closeout.unconfirmed.length} 个单元待确认是否使用`
      : "全部拍摄日和设备均满足收工要求";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Kocpy Project Media Report</title><style>*{box-sizing:border-box}body{font-family:-apple-system,"PingFang SC",sans-serif;color:#24212c;padding:28px;background:#f5f3f7;font-size:11px}.cover{padding:28px;border-radius:16px;color:#fff;background:linear-gradient(135deg,#6d5ee8,#9a88ff);display:flex;justify-content:space-between}.cover h1{margin:0;font-size:25px}.cover p{margin:8px 0 0;color:#eeeaff}.period{font-size:15px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.summary div,.section{background:#fff;border:1px solid #e7e2ee;border-radius:11px;padding:15px}.summary strong{display:block;font-size:19px}.summary span{display:block;color:#8b8493;font-size:8px;margin-top:5px}.section{margin-top:12px}.section h2{break-after:avoid;font-size:12px;margin:0 0 11px;padding-bottom:9px;border-bottom:1px solid #eee9f2}table{width:100%;border-collapse:collapse;table-layout:fixed}th{padding:8px;background:#eee9ff;color:#514783;text-align:left}td{vertical-align:top;line-height:1.55;padding:9px 8px;border-bottom:1px solid #eee;overflow-wrap:anywhere}tr{break-inside:avoid}.ok{color:#188b58}.warn{color:#bd4e5a}.muted{color:#999}.matrix-table th:last-child{width:29%}.task-table th:nth-child(1){width:13%}.task-table th:nth-child(2){width:12%}.task-table th:nth-child(3){width:28%}.task-table th:nth-child(4){width:7%}.task-table th:nth-child(5){width:10%}.task-table th:last-child{width:30%}.destination-table th:nth-child(1){width:24%}.destination-table th:nth-child(2){width:14%}.destination-table th:nth-child(3){width:48%}.destination-table th:nth-child(4){width:14%}.split td:first-child{font-size:9px;white-space:nowrap}.task-section{break-before:page}.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}.footer{text-align:center;color:#999;margin-top:18px}@page{size:A4;margin:12mm}@media print{body{padding:0;background:#fff}.section{break-inside:auto}}${summaryTableStyles}</style></head><body><div class="cover"><div><h1>Kocpy · 项目完整报告</h1><p>${esc(project.name)} · PROJECT MEDIA REPORT</p></div><div class="period">${esc(project.shootingDateStart || "-")} — ${esc(project.shootingDateEnd || project.shootingDateStart || "-")}<br>报告编号 ${esc(project.id.slice(0, 12).toUpperCase())}</div></div><div class="summary"><div><strong>${tasks.length}</strong><span>BACKUPS / 备份任务</span></div><div><strong>${completed} / ${tasks.length}</strong><span>SAFE TASKS / 达到副本要求</span></div><div><strong>${totalFiles}</strong><span>FILES / 文件</span></div><div><strong>${formatBytes(totalBytes)}</strong><span>MEDIA / 项目素材</span></div></div><div class="section"><p>${esc(projectTimeRulesSummary(project))}</p><h2>项目收工结论 · ${closeout.complete} / ${closeout.total} 个日期设备单元完成</h2><p class="${closeout.pending.length || closeout.unconfirmed.length ? "warn" : "ok"}">${closeoutMessage}</p></div><div class="section"><h2>日期 × 设备素材完成情况</h2><table class="matrix-table"><thead><tr><th>拍摄日期</th><th>设备 / 机位</th><th>素材卷</th><th>文件</th><th>素材量</th><th>收工状态</th></tr></thead><tbody>${matrixRows}</tbody></table></div><div class="split"><div class="section"><h2>每日素材趋势</h2><table><thead><tr><th>日期</th><th>素材卷</th><th>文件</th><th>素材量</th></tr></thead><tbody>${dailyRows}</tbody></table></div><div class="section"><h2>设备素材占比</h2><table><thead><tr><th>设备</th><th>素材卷</th><th>文件</th><th>素材量</th><th>占比</th></tr></thead><tbody>${deviceRows}</tbody></table></div></div><div class="section task-section"><h2>全部备份任务</h2><p>内容校验、接管首次基线和副本达标是不同结论。首次基线不证明接管前完整；有清单差异的任务须处理后才计为达标。同盘目录不增加独立副本，旧证据不足可重新校验在线目标。</p><table class="task-table"><thead><tr><th>日期</th><th>设备 / 机位</th><th>素材卷</th><th>文件</th><th>素材量</th><th>结论</th></tr></thead>${taskRows}</table></div><div class="section"><h2>目的地与独立校验</h2><p>以下是逐目标校验记录，不等于物理独立副本数量。清单缺失项不出现在现存文件明细中，须同时查看任务结论。</p><table class="destination-table"><thead><tr><th>素材卷</th><th>磁盘</th><th>最终路径</th><th>校验</th></tr></thead><tbody>${destinationRows}</tbody></table></div><div class="section"><h2>完整文件明细</h2><table class="file-detail-table"><thead><tr><th>日期</th><th>设备</th><th>素材卷</th><th>文件路径</th><th>大小</th><th>副本校验</th></tr></thead><tbody>${fileRows}</tbody></table></div><div class="footer">Kocpy · @sexyfeifan · 生成时间 ${formatEvidenceTime(Date.now(), captureTimeContext(project))}</div></body></html>`;
  return Buffer.from(html.replace('<div class="summary">', `${portableProjectReportSection(project)}<div class="summary">`), "utf8");
}
