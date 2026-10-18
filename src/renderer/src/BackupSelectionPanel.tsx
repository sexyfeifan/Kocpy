import { useEffect, useState } from "react";
import { CalendarDays, ShieldCheck, LoaderCircle, RotateCcw } from "lucide-react";
import { api, bytes, leaf } from "./api";
import { Button } from "./Ui";
import { readableOperationError } from "../../common/interaction";
import { backupSelectionSummary, validSelectionDate, type BackupSelectionGroup, type BackupSelectionPreview, type BackupSelectionPlan, type BackupSelectionProgress } from "../../common/backup-selection";
import { applyBatchShootingDate, batchAssignableGroups } from "./selection-date-assignment";
import "./BackupSelection.css";

/** Batch edits stay in the unconfirmed selection draft. Unknown/mandatory
 * families are not date-inferred, and no existing inclusion is removed. */
export function BatchShootingDateAssignment({ groups, assignedDates, selectedDates, shootingDate, disabled, onApply }: {
  groups: BackupSelectionGroup[]; assignedDates: Record<string, string>; selectedDates: string[];
  shootingDate?: string; disabled: boolean;
  onApply: (result: ReturnType<typeof applyBatchShootingDate>) => void;
}) {
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [message, setMessage] = useState("");
  const eligibleDates = [...new Set(groups.filter(group => !group.mandatory && validSelectionDate(group.suggestedDate))
    .map(group => assignedDates[group.id] || group.suggestedDate!).filter(validSelectionDate))].sort();
  const eligible = batchAssignableGroups(groups, assignedDates, from);
  return <details className="backup-selection-batch">
    <summary>大夜或日期不准？批量修正拍摄归属日</summary>
    <p className="muted small">仅修改下方素材组的归属草稿，不修改源文件时间，不自动取消任何日期的备份。未知日期、共享文件和必须保留的组不会被批量指派；仍可逐组查看依据。</p>
    {shootingDate && <p className="muted small">本次项目目录的拍摄归属日为 {shootingDate}；这里的修正不会改变该目录。</p>}
    <div className="backup-selection-batch-fields">
      <label>当前归属日期<select aria-label="批量修正的当前归属日期" value={from} disabled={disabled} onChange={event => { setFrom(event.target.value); setMessage(""); }}>
        <option value="">请选择需要修正的日期</option>
        {eligibleDates.map(date => <option key={date} value={date}>{date}</option>)}
      </select></label>
      <label>改为拍摄归属日<input type="date" aria-label="批量修正的拍摄归属日" disabled={disabled} value={to} onChange={event => { setTo(event.target.value); setMessage(""); }} /></label>
      <Button disabled={disabled || !eligible.length || !validSelectionDate(to) || from === to} onClick={() => {
        const result = applyBatchShootingDate(groups, assignedDates, selectedDates, from, to);
        onApply(result);
        setMessage(`已将 ${result.changedGroups} 组（${result.changedFiles} 个文件）的归属草稿改为 ${to}，并勾选该日期；尚未生效，仍需核对并由操作人确认本次范围。`);
      }}>应用到 {eligible.length} 组</Button>
    </div>
    {message && <p role="status">{message}</p>}
  </details>;
}

export function BackupSelectionPanel({ sourcePath, projectId, shootingDate, shootingZone, plan, disabled, onChange, onBusy, onDraft, onInspect }: {
  sourcePath: string; projectId?: string; shootingDate?: string; shootingZone?: string; plan?: BackupSelectionPlan; disabled: boolean;
  onChange: (plan?: BackupSelectionPlan) => void; onBusy: (busy: boolean) => void;
  onDraft: (pending: boolean) => void;
  onInspect: (pending: boolean) => void;
}) {
  const [inspection, setInspection] = useState<Awaited<ReturnType<typeof api.inspectBackupDates>>>();
  const [inspecting, setInspecting] = useState(true);
  const [preview, setPreview] = useState<BackupSelectionPreview>();
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const [assignedDates, setAssignedDates] = useState<Record<string, string>>({});
  const [operator, setOperator] = useState("");
  const [history, setHistory] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BackupSelectionProgress>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setInspecting(true); onInspect(true);
    void api.inspectBackupDates(sourcePath, projectId, shootingDate).then((result) => { if (active) setInspection(result); })
      .catch((error) => { if (active) setError(readableOperationError(error)); })
      .finally(() => { if (active) { setInspecting(false); onInspect(false); } });
    return () => { active = false; onInspect(false); };
  }, [sourcePath, projectId, shootingDate]);
  useEffect(() => api.onBackupSelectionProgress((value) => {
    if (value.sourcePath === sourcePath) setProgress(value);
  }), [sourcePath]);
  async function run(action: () => Promise<void>) {
    setBusy(true); onBusy(true); setError(""); setProgress(undefined);
    try { await action(); } catch (error) { setError(readableOperationError(error)); }
    finally { setBusy(false); onBusy(false); }
  }
  const dates = [...new Set((preview?.groups || []).map((group) => assignedDates[group.id] || group.suggestedDate).filter((date): date is string => Boolean(date)))].sort();
  const unselected = preview?.groups.filter((group) => !group.mandatory &&
    (assignedDates[group.id] || group.suggestedDate) && !selectedDates.includes(assignedDates[group.id] || group.suggestedDate!)) || [];
  const unsafe = unselected.filter((group) => !(history && group.historyState === "verified"));
  const summary = plan ? backupSelectionSummary(plan) : undefined;
  return <section className="backup-selection" aria-label={`素材日期范围 ${leaf(sourcePath)}`}>
    <div className="backup-selection-heading"><CalendarDays size={18} /><div>
      <strong>{leaf(sourcePath)} · 日期与备份范围</strong>
      <p>{plan ? "已冻结本次选择；开始前和完成时会重新检查源范围与历史依据。" : "默认整卡备份。日期仅是线索；不会按日期自动删除或跳过源文件。"}</p>
    </div></div>
    {projectId && <p className="muted small">拍摄时区：{shootingZone || "未确认；不要仅按文件日期剔除素材"} · 登记电脑时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}。开始后冻结；修改项目规则须重新分析。</p>}
    <p className="muted small">{shootingDate ? `本次项目目录使用拍摄归属日 ${shootingDate}。` : "普通备份不按拍摄日拆分目录。"}文件日期来自文件名或文件时间等线索，不等于拍摄归属日；跨零点可以仍属同一次拍摄。实际备份开始与完成时间另行记录，不会回填成拍摄日。</p>
    {inspecting ? <p role="status">正在只读查看日期线索，不修改素材…</p> : inspection && <p className={inspection.dates.length > 1 ? "backup-selection-warning" : "muted small"}>
      {inspection.dates.length > 1 ? `发现 ${inspection.dates.length} 个文件日期线索，可能是跨零点拍摄或混有多日素材，请确认归属：${inspection.dates.join("、")}` : "未发现可明确区分的多日素材；这不代表源卡一定只有所选拍摄日的内容。"}
      {inspection.unknownGroups > 0 && ` ${inspection.unknownGroups} 组日期或关联关系待确认，默认保留。`}
    </p>}
    {summary ? <>
      <p><strong>本次 {summary.includedFiles} 个文件 · {bytes(summary.includedBytes)}</strong>；未复制 {summary.excludedFiles} 个，其中历史已验证 {summary.historicalFiles} 个、尚未证实保护 {summary.unprotectedFiles} 个。</p>
      {summary.excludedFiles > 0 && <p className="backup-selection-warning">这是选定范围备份，不是整卡副本。旧素材不会出现在本次目的地；不能据此清空或格式化源卡。</p>}
      <Button disabled={disabled || busy} onClick={() => { onChange(); setPreview(undefined); onDraft(false); }}><RotateCcw size={15} />恢复整卡备份</Button>
    </> : !preview ? <Button disabled={disabled || busy || inspecting} onClick={() => void run(async () => {
      const result = await api.analyzeBackupSelection(sourcePath, projectId, shootingDate);
      setPreview(result); setSelectedDates([...new Set(result.groups.flatMap((group) => group.suggestedDate ? [group.suggestedDate] : []))]);
      onDraft(true);
      setAssignedDates({}); setAcknowledged(false);
    })}><ShieldCheck size={15} />分析并选择日期范围</Button> : <>
      <p className="muted small">已逐文件读取 SHA-256。只有同项目、当前在线、内容一致且达到物理独立副本要求的历史素材，才允许标为“历史已保护”。其他未选内容需要单独风险确认。</p>
      <fieldset className="backup-selection-dates" disabled={busy || disabled}><legend>选择本次需要的拍摄归属日（默认全部）</legend>
        {dates.map((date) => <label key={date}><input type="checkbox" checked={selectedDates.includes(date)} onChange={(event) => {
          setSelectedDates((all) => event.target.checked ? [...all, date] : all.filter((item) => item !== date)); setAcknowledged(false);
        }} />{date}</label>)}
        {!dates.length && <p>未识别可用日期。所有素材保持整卡备份，也可在下方逐组确认拍摄归属日。</p>}
      </fieldset>
      <BatchShootingDateAssignment groups={preview.groups} assignedDates={assignedDates} selectedDates={selectedDates} shootingDate={shootingDate} disabled={busy || disabled} onApply={(result) => {
        setAssignedDates(result.assignedDates); setSelectedDates(result.selectedDates); setAcknowledged(result.acknowledged); onDraft(true);
      }} />
      <details className="backup-selection-groups"><summary>查看素材组、关联文件和日期依据（{preview.groups.length} 组）</summary>
        <div>{preview.groups.map((group) => <article key={group.id}>
          <strong>{group.label}</strong><span>{group.files} 个文件 · {bytes(group.bytes)}</span>
          <p>{group.mandatory ? `必须保留：${group.mandatoryReason}` : `${group.historyState === "verified" ? `历史副本已验证 ${group.historyCopies} 份` : "未证实足够的在线历史副本"} · 日期依据：${group.evidence.join("；")}`}</p>
          {!group.mandatory && <p className="muted small">原始日期线索：{group.suggestedDate || "未知"}；下方修改只记录拍摄归属，不改源时间。</p>}
          {!group.mandatory && <label>确认拍摄归属日（跨零点可归为同一拍摄日）<input type="date" disabled={busy || disabled} value={assignedDates[group.id] || group.suggestedDate || ""} onChange={(event) => {
            const date = event.target.value; setAssignedDates((all) => ({ ...all, [group.id]: date }));
            if (date) setSelectedDates((all) => all.includes(date) ? all : [...all, date]); setAcknowledged(false);
          }} /></label>}
          <details><summary>关联路径</summary><ul>{group.relativePaths.map((location) => <li key={location}>{location}</li>)}</ul></details>
        </article>)}</div>
      </details>
      <p className="backup-selection-warning">共享索引、未知文件、不能安全拆分的摄影机包始终保留；同名关联文件按组处理。文件名和文件时间不能单独证明“已备份”。</p>
      <label className="backup-selection-check"><input type="checkbox" disabled={busy || disabled} checked={history} onChange={(event) => { setHistory(event.target.checked); setAcknowledged(false); }} />对未选日期，使用本次重新验证的历史副本作为跳过依据</label>
      {unsafe.length > 0 && <label className="backup-selection-check backup-selection-warning"><input type="checkbox" disabled={busy || disabled} checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />我确认 {unsafe.length} 组未选素材尚未证实已有足够备份；本次不复制这些内容，不能据此清空源卡。</label>}
      <div className="backup-selection-actions"><label>范围确认人<input value={operator} disabled={busy || disabled} maxLength={120} placeholder="实际操作人姓名" onChange={(event) => setOperator(event.target.value)} /></label>
        <Button kind="primary" disabled={busy || disabled || !operator.trim() || (unsafe.length > 0 && !acknowledged)} onClick={() => void run(async () => {
          const result = await api.confirmBackupSelection(preview.id, { selectedDates,
            assignedDates: Object.fromEntries(preview.groups.filter((group) => !group.mandatory).map((group) => [group.id, assignedDates[group.id] || group.suggestedDate]).filter((entry) => Boolean(entry[1]))) as Record<string, string>,
            skipVerifiedHistory: history, allowUnprotectedExclusions: acknowledged, operator });
          onChange(result); onDraft(false);
        })}>确认本次范围</Button>
        <Button disabled={busy || disabled} onClick={() => { setPreview(undefined); onChange(); onDraft(false); }}>保留整卡备份</Button>
      </div>
      <p className="muted small">点击“确认本次范围”也表示确认上方素材组的拍摄归属日。请先展开检查日期依据；时间不准或跨零点时先修改，未知与共享文件不会被自动分到某个拍摄日。调整归属不会自动取消选中；仍需明确选择本次备份范围。</p>
    </>}
    {busy && <div role="status" className="backup-selection-progress"><LoaderCircle size={16} className="spin" /><span>{progress ? `${({ scanning: "扫描", hashing: "读取校验值", history: "核对历史副本", validating: "复核范围" })[progress.phase]} · ${progress.completedFiles}/${progress.totalFiles} 个文件 · ${bytes(progress.completedBytes)}/${bytes(progress.totalBytes)}${progress.currentFile ? ` · ${progress.currentFile}` : ""}` : "准备只读分析…"}</span><Button onClick={() => void api.cancelBackupSelection()}>取消分析</Button></div>}
    {error && <p role="alert" className="backup-selection-warning">{error}。未确认的筛选不会生效；请重新确认范围，或明确恢复整卡备份后再开始，不会自动跳过文件。</p>}
  </section>;
}
