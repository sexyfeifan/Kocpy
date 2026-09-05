import { useMemo, useState } from "react";
import { AlertTriangle, Check, Download, ShieldCheck, X } from "lucide-react";
import type {
  WorkspaceConflictDecision,
  WorkspaceImportDecision,
  WorkspaceImportPreview,
  WorkspaceMergeResult,
} from "../../main/types";
import { api } from "./api";
import { Button } from "./Ui";
import { readableOperationError } from "../../common/interaction";

export function WorkstationImportDialog({
  preview,
  defaultOperator,
  onClose,
  onApplied,
}: {
  preview: WorkspaceImportPreview;
  defaultOperator: string;
  onClose: () => void;
  onApplied: (result: WorkspaceMergeResult) => void;
}) {
  const [choices, setChoices] = useState<
      Record<string, WorkspaceConflictDecision>
    >(Object.fromEntries(preview.conflicts.map((item) => [item.id, "local"]))),
    [operator, setOperator] = useState(defaultOperator),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const incoming = useMemo(
      () =>
        Object.values(choices).filter((value) => value === "incoming").length,
      [choices],
    ),
    decisions: WorkspaceImportDecision[] = Object.entries(choices).map(
      ([conflictId, decision]) => ({ conflictId, decision }),
    );
  const apply = async () => {
    if (!operator.trim() || !confirmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.applyWorkspaceImport(
        preview.previewId,
        decisions,
        operator.trim(),
      );
      if (result) onApplied(result);
      else setError("已取消，工作站元数据没有提交。");
    } catch (reason) {
      setError(readableOperationError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal workstation-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="预检并合并工作站包"
        aria-busy={busy}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">WORKSTATION EXCHANGE</span>
            <h2>预检并合并工作站包</h2>
          </div>
          <Button kind="icon" title="关闭" onClick={onClose} disabled={busy}>
            <X size={19} />
          </Button>
        </div>
        <div className="form-body workstation-import-body">
          <div className="notice">
            <ShieldCheck size={17} />
            <span>
              这是只读预检结果。默认保留本机冲突；只有逐项选择“采用外部”并确认后才提交元数据。
              不会复制、移动、删除或重新校验原始素材。
            </span>
          </div>
          <div className="workstation-source-card">
            <div>
              <span>来源工作站</span>
              <strong>{preview.source.displayName}</strong>
              <small>
                {preview.source.workstationId || "旧版包未记录稳定工作站 ID"}
              </small>
              <small>
                {preview.source.exportId
                  ? `导出 ID ${preview.source.exportId}`
                  : "旧版包未记录导出 ID"}
                {preview.source.exportedAt
                  ? ` · ${new Date(preview.source.exportedAt).toLocaleString()}`
                  : ""}
              </small>
            </div>
            <div>
              <span>配置包</span>
              <strong>{preview.fileName}</strong>
              <small className="mono">SHA-256 {preview.packageSha256}</small>
            </div>
            <div>
              <span>本机预检基线</span>
              <strong>修订 {preview.localRevision}</strong>
              <small className="mono">工作区 {preview.localDigest}</small>
              <small className="mono">
                交换范围 {preview.localExchangeDigest}
              </small>
            </div>
          </div>
          <div className="workstation-summary-grid">
            <div>
              <strong>{preview.summary.projectsAdded}</strong>
              <span>新增项目</span>
            </div>
            <div>
              <strong>{preview.summary.tasksAdded}</strong>
              <span>新增任务</span>
            </div>
            <div>
              <strong>{preview.summary.exactDuplicates}</strong>
              <span>精确重复</span>
            </div>
            <div>
              <strong>{preview.summary.conflicts}</strong>
              <span>需要决定</span>
            </div>
          </div>
          {preview.warnings.map((warning) => (
            <div className="notice amber" key={warning}>
              <AlertTriangle size={15} />
              <span>{warning}</span>
            </div>
          ))}
          <div className="workstation-conflict-header">
            <div>
              <h3>冲突决定</h3>
              <p>
                {preview.conflicts.length
                  ? `共 ${preview.conflicts.length} 项；当前 ${incoming} 项采用外部，其余保留本机。`
                  : "没有需要人工决定的冲突。"}
              </p>
            </div>
          </div>
          <div className="workstation-conflicts">
            {preview.conflicts.map((item) => (
              <article className="workstation-conflict" key={item.id}>
                <div className="workstation-conflict-title">
                  <div>
                    <strong>{item.label}</strong>
                    <small>{item.consequence}</small>
                  </div>
                  <span className="badge attention">{item.kind}</span>
                </div>
                <div className="workstation-conflict-values">
                  <label>
                    <input
                      type="radio"
                      name={item.id}
                      checked={choices[item.id] === "local"}
                      onChange={() =>
                        setChoices((current) => ({
                          ...current,
                          [item.id]: "local",
                        }))
                      }
                    />
                    <span>
                      <b>保留本机（默认）</b>
                      <small>{item.localSummary}</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={item.id}
                      checked={choices[item.id] === "incoming"}
                      onChange={() =>
                        setChoices((current) => ({
                          ...current,
                          [item.id]: "incoming",
                        }))
                      }
                    />
                    <span>
                      <b>采用外部</b>
                      <small>{item.incomingSummary}</small>
                    </span>
                  </label>
                </div>
              </article>
            ))}
          </div>
          <div className="workstation-confirmation">
            <label>
              <span>实际操作人</span>
              <input
                value={operator}
                maxLength={120}
                placeholder="填写执行本次合并的人"
                onChange={(event) => setOperator(event.target.value)}
              />
            </label>
            <label className="checkline">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                我已核对来源、包摘要与上述逐项决定，并确认本次只合并 Kocpy
                元数据。
              </span>
            </label>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <AlertTriangle size={15} />
              <span>{error}</span>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button kind="subtle" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            kind="primary"
            disabled={!operator.trim() || !confirmed || busy}
            onClick={() => void apply()}
          >
            {busy ? (
              <Download className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            {preview.alreadyImported ? "核对审计并幂等提交" : "按上述决定合并"}
          </Button>
        </div>
      </section>
    </div>
  );
}
