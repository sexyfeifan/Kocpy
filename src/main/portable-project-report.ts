import type { ProjectConfig } from "./types";
import { portableProvenanceText } from "../common/portable-project";
/** Reference-only projects can export evidence, not task-derived manifests or bundles. */
export function assertProjectReportAvailable(
  project: ProjectConfig,
  taskCount: number,
  format: string,
) {
  if (taskCount > 0) return;
  if (
    project.portableHistory?.length &&
    (format === "pdf" || format === "json")
  )
    return;
  throw new Error(
    project.portableHistory?.length
      ? "本机尚无拷卡任务；可导出随盘历史 PDF／JSON，不能生成任务素材统计或整卡归档包"
      : "当前项目还没有可导出的备份记录",
  );
}
const esc = (s: unknown) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
/** Referenced history is visibly separate from local verified-task statistics. */
export function portableProjectReportSection(project: ProjectConfig) {
  const history = project.portableHistory?.at(-1);
  if (!history) return "";
  return `<div class="section"><h2>随盘历史参考 · 不计入下方本机任务与独立副本统计</h2><p>${esc(portableProvenanceText(history.provenance))}。项目 ${esc(history.project.name)}；计划期 ${esc(history.project.plannedStart || "未记录")} 至 ${esc(history.project.plannedEnd || "未记录")}；设备 ${esc(history.project.devices.join("、"))}。</p><p>历史 ${history.rolls.length} 卷；当前基线 ${history.files} 文件 / ${history.bytes} 字节；有意移除 ${history.exclusions} 项。导入人 ${esc(history.operator)}；修订 ${esc(history.revision)}；摘要 ${esc(history.sha256)}。不证明原始整卡齐全，不授予安全清卡或物理独立性结论。</p><table><thead><tr><th>原素材卷</th><th>已记录拍摄日期 / 设备</th><th>范围与原状态</th></tr></thead><tbody>${history.rolls
    .slice(0, 100)
    .map(
      (r) =>
        `<tr><td>${esc(r.name)}<br>${r.files} 文件 / ${r.bytes} 字节</td><td>${esc(r.dates.join("、") || "日期未记录")}<br>${esc(r.devices.join("、"))}</td><td>${esc(r.scope)}<br>原状态 ${esc(r.status)}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table>${history.rolls.length > 100 ? "<p>此处显示前100卷，完整摘要见项目 JSON / 随盘项目文件。</p>" : ""}</div>`;
}

export function portableReferenceProjectReport(project: ProjectConfig) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Kocpy 随盘项目历史参考</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font:12px/1.65 -apple-system,"PingFang SC",sans-serif;color:#20242b;padding:12px}h1{font-size:24px;overflow-wrap:anywhere}.section{border:1px solid #dde1e6;border-radius:12px;padding:18px;margin-top:20px}h2{font-size:15px}p,td{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}th,td{padding:9px;text-align:left;vertical-align:top;border-bottom:1px solid #e0e3e7}tr{break-inside:avoid}th{background:#edf1f6}</style></head><body><h1>${esc(project.name)}</h1><p>Kocpy · 随盘项目历史参考报告</p><p>本机没有拷卡任务。本报告不重造每日收工、空目录、原始整卡或独立副本结论；NAS 转存事实请同时查看单独的归档转存 PDF / PNG。</p>${portableProjectReportSection(project)}</body></html>`;
}
