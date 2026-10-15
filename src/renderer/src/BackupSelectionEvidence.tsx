import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { BackupTask } from "./api";
import { backupSelectionSummary } from "../../common/backup-selection";
import { taskHasPartialSelection } from "../../common/task-trust";
import "./backup-selection-evidence.css";

/** Read-only frozen decision evidence; never reclassifies or writes source files. */
export function BackupSelectionEvidence({ task }: { task: BackupTask }) {
  const [limit, setLimit] = useState(50), plan = task.selection;
  const evidence = useMemo(() => plan ? {
    summary: backupSelectionSummary(plan), groups: new Map(plan.groups.map(group => [group.id, group])),
  } : undefined, [plan]);
  if (!plan || !evidence) return null;
  const { summary, groups } = evidence, partial = taskHasPartialSelection(task);
  return <section className="selection-evidence" aria-label="已确认的备份范围">
    <div className="selection-evidence-heading"><strong>已确认的备份范围</strong><span>{partial ? "选定范围 · 非整卡副本" : "全部已扫描文件"}</span></div>
    <dl className="selection-evidence-metrics">
      {[["完整源已扫描", plan.sourceFiles.length], ["本次纳入", summary.includedFiles], ["未复制", summary.excludedFiles], ["历史已验证", summary.historicalFiles], ["未保护", summary.unprotectedFiles]].map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value} 个文件</dd></div>)}
    </dl>
    {partial && <p className="selection-evidence-warning"><TriangleAlert size={16} aria-hidden="true" /><span>本次未复制 {summary.excludedFiles} 个文件。范围内校验通过不等于整卡完整，不得据此格式化源素材卡。</span></p>}
    <p className="selection-evidence-note">以上数量仅包括原扫描已读取的文件；系统目录和无权限条目另列于扫描排除。历史已验证只代表预检时另一个位置的副本依据，不表示文件已复制到本次目的地。</p>
    <details className="selection-evidence-details">
      <summary>确认记录与未复制明细 · {summary.excludedFiles} 个文件</summary>
      <dl className="selection-evidence-decision">
        <div><dt>选定拍摄日</dt><dd>{plan.selectedDates.join("、") || "仅保留必须及未知日期内容"}</dd></div>
        <div><dt>确认人</dt><dd>{plan.operator}</dd></div>
        <div><dt>确认时间</dt><dd>{new Date(plan.confirmedAt).toLocaleString("zh-CN")}</dd></div>
      </dl>
      <ol className="selection-evidence-files">
        {plan.excludedFiles.slice(0, limit).map(file => {
          const group = groups.get(file.groupId);
          return <li key={file.relativePath}>
            <strong className="mono">{file.relativePath}</strong>
            <span>{file.reason === "history-verified" ? "历史副本预检已读取核对；未复制到本次目的地" : "用户未选择该日期；未证明此文件已受保护"}</span>
            {group && <>
              <span>关联组：{group.label} · {group.files} 个关联文件 · 日期 {plan.assignedDates[group.id] || group.suggestedDate || "未知"}{plan.assignedDates[group.id] ? "（人工确认）" : "（扫描建议）"}</span>
              <span>关联规则：同名主体与伴随文件作为一组处理；摄影机包及无法确认依赖的共享内容保守保留。</span>
              <span>判定依据：{group.evidence.join("；") || "无额外日期依据；保留确认记录"}</span>
              <details><summary>查看关联组路径 · {group.relativePaths.length} 项</summary><ul>{group.relativePaths.map(relative => <li className="mono" key={relative}>{relative}</li>)}</ul></details>
            </>}
            {file.historyEvidence.length > 0 && <details><summary>历史副本依据 · {file.historyEvidence.length} 项</summary><ul>{file.historyEvidence.map(evidence => <li key={`${evidence.taskId}:${evidence.path}`}><span className="mono">{evidence.path}</span><span>任务 {evidence.taskId} · {new Date(evidence.checkedAt).toLocaleString("zh-CN")} · 仅代表当时读取核对</span></li>)}</ul></details>}
          </li>;
        })}
      </ol>
      {summary.excludedFiles > limit && <button type="button" className="btn small" onClick={() => setLimit(value => value + 50)}>显示后续 {Math.min(50, summary.excludedFiles - limit)} 个未复制文件</button>}
      {!summary.excludedFiles && <p className="selection-evidence-note">本次日期选择没有排除已扫描文件；仍需单独核对系统扫描排除和独立副本要求。</p>}
    </details>
  </section>;
}
