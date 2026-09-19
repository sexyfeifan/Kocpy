import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  FileCheck2,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  api,
  bytes,
  type BackupTask,
  type CardDateAllocationPlan,
  type DailyDeliveryRun,
} from "./api";
import { Button } from "./Ui";

const readable = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(/^Error: /, "");

const runLabel: Record<DailyDeliveryRun["status"], string> = {
  pending: "等待开始",
  running: "正在生成",
  interrupted: "已中断，可继续",
  completed: "交付文件已校验",
  failed: "失败，可继续",
};

export function MixedDayDeliveryDialog({
  taskId,
  defaultOperator,
  onClose,
  onChanged,
}: {
  taskId: string;
  defaultOperator?: string;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const [task, setTask] = useState<BackupTask>();
  const [sourceDestinationId, setSourceDestinationId] = useState("");
  const [plan, setPlan] = useState<CardDateAllocationPlan>();
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [operator, setOperator] = useState(defaultOperator || "");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [destinationParent, setDestinationParent] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [search, setSearch] = useState("");
  const [visibleGroups, setVisibleGroups] = useState(200);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const load = async (quiet = false) => {
    try {
      const next = await api.getTask(taskId);
      setTask(next);
      setPlan((current) => next.dateAllocation || current);
      setSourceDestinationId((current) =>
        next.destinations.some(
          (destination) =>
            destination.id === current &&
            destination.verified &&
            destination.resolvedPath,
        )
          ? current
          : next.destinations.find(
                (destination) =>
                  destination.verified && destination.resolvedPath,
              )?.id || "",
      );
    } catch (error) {
      if (!quiet) setMessage({ text: readable(error), error: true });
    }
  };

  useEffect(() => {
    void load();
    const unsubscribe = api.onWorkspaceChanged(() => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void load(true), 350);
    });
    return () => {
      unsubscribe();
      clearTimeout(refreshTimer.current);
    };
  }, [taskId]);

  useEffect(() => {
    if (!plan) return;
    setAssignments(
      Object.fromEntries(
        plan.groups.map((group) => [group.id, group.assignedDate || ""]),
      ),
    );
  }, [plan?.sourceEvidenceDigest, plan?.updatedAt]);

  const sourceDestinations =
    task?.destinations.filter(
      (destination) => destination.verified && destination.resolvedPath,
    ) || [];
  const assignedDates = useMemo(
    () =>
      [
        ...new Set(
          plan?.groups
            .map((group) => assignments[group.id])
            .filter(Boolean) || [],
        ),
      ].sort(),
    [plan, assignments],
  );
  useEffect(() => {
    if (!assignedDates.includes(deliveryDate))
      setDeliveryDate(assignedDates.at(-1) || "");
  }, [assignedDates.join("\0")]);

  const suggestionBuckets = useMemo(() => {
    const buckets = new Map<
      string,
      { date: string; groups: number; files: number; bytes: number; review: number }
    >();
    for (const group of plan?.groups || []) {
      const key = group.suggestedDate || "";
      const bucket = buckets.get(key) || {
        date: key,
        groups: 0,
        files: 0,
        bytes: 0,
        review: 0,
      };
      bucket.groups += 1;
      bucket.files += group.files;
      bucket.bytes += group.bytes;
      if (group.suggestionConfidence !== "high") bucket.review += 1;
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
  }, [plan]);

  const matchingGroups = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return (plan?.groups || []).filter(
      (group) =>
        !query ||
        group.label.toLocaleLowerCase("zh-CN").includes(query) ||
        group.relativePaths.some((item) =>
          item.toLocaleLowerCase("zh-CN").includes(query),
        ),
    );
  }, [plan, search]);

  const analyze = async () => {
    if (!sourceDestinationId) return;
    setBusy("analyze");
    setMessage(undefined);
    try {
      const next = await api.previewCardDateAllocation(
        taskId,
        sourceDestinationId,
      );
      setPlan(next);
      setMessage({
        text: `分析完成：${next.groups.length} 个素材组。日期只是建议，保存前仍需人工确认。`,
        error: false,
      });
    } catch (error) {
      setMessage({ text: readable(error), error: true });
    } finally {
      setBusy("");
    }
  };

  const applySuggestedDate = (date: string) => {
    if (!plan || !date) return;
    setAssignments((current) => ({
      ...current,
      ...Object.fromEntries(
        plan.groups
          .filter((group) => group.suggestedDate === date)
          .map((group) => [group.id, date]),
      ),
    }));
  };

  const saveAllocation = async () => {
    if (!plan || !operator.trim()) {
      setMessage({ text: "请填写实际确认人", error: true });
      return;
    }
    setBusy("save");
    setMessage(undefined);
    try {
      const saved = await api.saveCardDateAllocation(
        taskId,
        sourceDestinationId,
        plan.groups.map((group) => ({
          groupId: group.id,
          shootingDate: assignments[group.id] || undefined,
        })),
        operator.trim(),
      );
      setPlan(saved);
      await load(true);
      await onChanged();
      setMessage({
        text: `日期归属已记录：${saved.groups.filter((group) => group.assignedDate).length}/${saved.groups.length} 个素材组已有人工确认日期。`,
        error: false,
      });
    } catch (error) {
      setMessage({ text: readable(error), error: true });
    } finally {
      setBusy("");
    }
  };

  const chooseDestination = async () => {
    const value = await api.selectDirectory(destinationParent || undefined);
    if (value) setDestinationParent(value);
  };

  const acceptDroppedDirectory = async (files: File[]) => {
    const paths = api.resolveDroppedPaths(files);
    if (!paths.length) return;
    try {
      const values = await api.validateDirectories(paths.slice(0, 1));
      if (values[0]) setDestinationParent(values[0]);
    } catch (error) {
      setMessage({ text: readable(error), error: true });
    }
  };

  const runDelivery = async (existing?: DailyDeliveryRun) => {
    const shootingDate = existing?.shootingDate || deliveryDate,
      parent = existing?.destinationParent || destinationParent,
      sourceId = existing?.sourceDestinationId || sourceDestinationId;
    if (!shootingDate || !parent || !operator.trim()) {
      setMessage({ text: "请选择日期和目的地，并填写实际操作人", error: true });
      return;
    }
    if (!existing && !acknowledged) {
      setMessage({ text: "请先确认当日交付的证据边界", error: true });
      return;
    }
    setBusy(existing ? `resume:${existing.id}` : "deliver");
    setMessage(undefined);
    try {
      const result = await api.createDailyDelivery({
        taskId,
        runId: existing?.id,
        shootingDate,
        sourceDestinationId: sourceId,
        destinationParent: parent,
        operator: existing?.operator || operator.trim(),
      });
      await load(true);
      await onChanged();
      setMessage({
        text:
          result.status === "completed"
            ? result.reportStatus === "completed"
              ? "当日交付及 PDF 报告已完成"
              : "交付文件已校验；PDF 报告保存失败，可单独重试"
            : result.error || "当日交付尚未完成",
        error: result.status !== "completed" || result.reportStatus === "failed",
      });
    } catch (error) {
      await load(true);
      setMessage({ text: readable(error), error: true });
    } finally {
      setBusy("");
    }
  };

  const retryReport = async (run: DailyDeliveryRun) => {
    setBusy(`report:${run.id}`);
    setMessage(undefined);
    try {
      const next = await api.retryDailyDeliveryReport(taskId, run.id);
      await load(true);
      await onChanged();
      setMessage({
        text:
          next.reportStatus === "completed"
            ? "当日交付 PDF 报告已补齐"
            : next.reportError || "报告仍未完成",
        error: next.reportStatus !== "completed",
      });
    } catch (error) {
      setMessage({ text: readable(error), error: true });
    } finally {
      setBusy("");
    }
  };

  if (!task)
    return (
      <div className="modal-backdrop top-layer">
        <section
          className="form-modal mixed-day-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="正在读取完整素材卷记录"
          aria-busy="true"
        >
          <div className="modal-header"><h2>读取完整素材卷记录…</h2></div>
        </section>
      </div>
    );

  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal mixed-day-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mixed-day-title"
        aria-busy={Boolean(busy)}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">IMMUTABLE CARD · DAILY DELIVERY</p>
            <h2 id="mixed-day-title">完整卡日期归属与当日交付</h2>
            <p>{task.name} · 完整卡不修改、不删除，交付副本单独生成并校验</p>
          </div>
          <Button kind="icon" title="关闭" onClick={onClose}><X size={18} /></Button>
        </div>
        <div className="mixed-day-body">
          {message && (
            <div className={`mixed-day-message ${message.error ? "error" : "ok"}`} role="status">
              {message.text}
            </div>
          )}
          <section className="mixed-day-section">
            <div className="mixed-day-section-heading">
              <span><ShieldCheck size={18} /><strong>1. 从完整校验副本分析日期</strong></span>
              <Button kind="subtle" disabled={!sourceDestinationId || Boolean(busy)} onClick={() => void analyze()}>
                <RefreshCw size={14} />{busy === "analyze" ? "正在分析" : "重新分析"}
              </Button>
            </div>
            <label className="field-label">完整素材卷副本
              <select value={sourceDestinationId} onChange={(event) => setSourceDestinationId(event.target.value)}>
                {sourceDestinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>{destination.label} · {destination.resolvedPath}</option>
                ))}
              </select>
            </label>
            <p className="muted small">媒体内嵌日期、路径日期和修改时间只用于给出建议；Kocpy 不会自动把建议当作事实。</p>
          </section>

          {plan && (
            <section className="mixed-day-section">
              <div className="mixed-day-section-heading">
                <span><CalendarDays size={18} /><strong>2. 人工确认素材组日期</strong></span>
                <span className="muted small">{Object.values(assignments).filter(Boolean).length}/{plan.groups.length} 组已填写</span>
              </div>
              <div className="mixed-day-buckets">
                {suggestionBuckets.map((bucket) => (
                  <div key={bucket.date || "unknown"}>
                    <strong>{bucket.date || "无法建议日期"}</strong>
                    <span>{bucket.groups} 组 · {bucket.files} 文件 · {bytes(bucket.bytes)}</span>
                    <small>{bucket.review ? `${bucket.review} 组需重点复核` : "高置信度建议"}</small>
                    {bucket.date && <Button kind="subtle" onClick={() => applySuggestedDate(bucket.date)}>填入此建议</Button>}
                  </div>
                ))}
              </div>
              <div className="mixed-day-review-tools">
                <input
                  aria-label="搜索卷名或相对路径"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setVisibleGroups(200);
                  }}
                  placeholder="搜索卷名或相对路径"
                />
                <span>{matchingGroups.length} 组</span>
              </div>
              <div className="mixed-day-groups">
                {matchingGroups.slice(0, visibleGroups).map((group) => (
                  <div className="mixed-day-group" key={group.id}>
                    <div><strong>{group.label}</strong><span>{group.files} 文件 · {bytes(group.bytes)}</span><small>{group.relativePaths[0]}</small></div>
                    <div className="mixed-day-suggestion">
                      <span>建议 {group.suggestedDate || "无"}</span>
                      <small>{group.evidence.join("；") || "没有可用日期证据"}</small>
                    </div>
                    <label>确认日期
                      <input type="date" value={assignments[group.id] || ""} onChange={(event) => setAssignments((current) => ({ ...current, [group.id]: event.target.value }))} />
                    </label>
                  </div>
                ))}
              </div>
              {matchingGroups.length > visibleGroups && (
                <Button kind="subtle" onClick={() => setVisibleGroups((value) => value + 200)}>继续显示 200 组</Button>
              )}
              <div className="mixed-day-confirm-row">
                <label className="field-label">实际确认人<input value={operator} onChange={(event) => setOperator(event.target.value)} placeholder="DIT / 数据管理员姓名" /></label>
                <Button kind="primary" disabled={!operator.trim() || Boolean(busy)} onClick={() => void saveAllocation()}><Check size={15} />{busy === "save" ? "正在保存" : "确认并保存日期归属"}</Button>
              </div>
            </section>
          )}

          {plan && assignedDates.length > 0 && (
            <section className="mixed-day-section">
              <div className="mixed-day-section-heading"><span><FileCheck2 size={18} /><strong>3. 生成独立的当日交付副本</strong></span></div>
              <div className="mixed-day-delivery-fields">
                <label className="field-label">已确认拍摄日<select value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)}>{assignedDates.map((value) => <option key={value}>{value}</option>)}</select></label>
                <label className="field-label">交付父目录<div className="path-input-row"><input value={destinationParent} onChange={(event) => setDestinationParent(event.target.value)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void acceptDroppedDirectory([...event.dataTransfer.files]); }} placeholder="选择或拖入文件夹" /><Button kind="subtle" onClick={() => void chooseDestination()}><FolderOpen size={14} />选择</Button></div></label>
              </div>
              <label className="mixed-day-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>我确认这是从完整卡派生的交付副本；它不删除完整卡、不替代正式备份证据，也不证明未选择素材可以删除。</span></label>
              <Button kind="primary" disabled={!acknowledged || !deliveryDate || !destinationParent || !operator.trim() || Boolean(busy)} onClick={() => void runDelivery()}><ShieldCheck size={15} />{busy === "deliver" ? "正在复制并独立回读" : "开始生成并校验当日交付"}</Button>
            </section>
          )}

          {!!task.dailyDeliveryRuns?.length && (
            <section className="mixed-day-section">
              <div className="mixed-day-section-heading"><span><FileCheck2 size={18} /><strong>当日交付记录</strong></span></div>
              <div className="mixed-day-runs">
                {task.dailyDeliveryRuns.slice().reverse().map((run) => {
                  const percent = run.totalBytes ? Math.min(100, (run.completedBytes / run.totalBytes) * 100) : run.status === "completed" ? 100 : 0;
                  return <article key={run.id}>
                    <div><strong>{run.shootingDate} · {runLabel[run.status]}</strong><span>{run.completedFiles}/{run.totalFiles} 文件 · {bytes(run.completedBytes)}/{bytes(run.totalBytes)}</span></div>
                    <div className="mixed-day-progress"><i style={{ width: `${percent}%` }} /></div>
                    <p className="mono">{run.finalPath}</p>
                    {run.error && <p className="error-text">{run.error}</p>}
                    {run.reportError && <p className="error-text">报告：{run.reportError}</p>}
                    <div className="row">
                      <Button kind="subtle" onClick={() => void api.reveal(run.finalPath)}><FolderOpen size={13} />Finder</Button>
                      {["failed", "interrupted"].includes(run.status) && <Button kind="subtle" disabled={Boolean(busy)} onClick={() => void runDelivery(run)}><RefreshCw size={13} />继续同一任务</Button>}
                      {run.status === "completed" && run.reportStatus === "failed" && <Button kind="subtle" disabled={Boolean(busy)} onClick={() => void retryReport(run)}><RefreshCw size={13} />重试 PDF</Button>}
                    </div>
                  </article>;
                })}
              </div>
            </section>
          )}
        </div>
        <div className="modal-footer">
          <span className="muted small">完整素材卷和原始清单始终保持不变</span>
          <Button kind="subtle" onClick={onClose}>关闭</Button>
        </div>
      </section>
    </div>
  );
}
