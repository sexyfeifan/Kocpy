import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  Plus,
  X,
} from "lucide-react";
import { api, bytes, type BackupTask } from "./api";
import { Button } from "./Ui";
import { readableOperationError } from "../../common/interaction";
import { recoveryAdvice, type RecoveryReport } from "../../common/recovery";

export function RecoveryDialog({
  task,
  onClose,
  onRecovered,
  onNewTask,
  onExternal,
}: {
  task: BackupTask;
  onClose: () => void;
  onRecovered: () => Promise<void>;
  onNewTask: (source?: string) => void;
  onExternal: () => void;
}) {
  const [report, setReport] = useState<RecoveryReport | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const advice = recoveryAdvice(
    [task.errorMessage, ...task.destinations.map((d) => d.error)]
      .filter(Boolean)
      .join("；"),
  );
  const native = !task.provenance || task.provenance === "kocpy-transfer";
  async function inspect() {
    setBusy(true);
    setError("");
    setReport(null);
    setConfirmed(false);
    try {
      setReport(await api.inspectTaskRecovery(task.id));
    } catch (e) {
      setError(readableOperationError(e));
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    setBusy(true);
    setError("");
    try {
      await api.recoverTask(task.id);
      await onRecovered();
      onClose();
    } catch (e) {
      setError(readableOperationError(e));
      setReport(null);
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="检查并恢复备份"
        aria-busy={busy}
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">SAFE RECOVERY</div>
            <h2>检查并恢复</h2>
            <p>{task.name}</p>
          </div>
          <Button kind="icon" title="关闭" disabled={busy} onClick={onClose}>
            <X size={20} />
          </Button>
        </div>
        <div className="modal-body">
          <div className="recovery-explanation">
            <AlertTriangle size={20} />
            <div>
              <strong>{advice.title}</strong>
              <p>{task.errorMessage || "任务未完成，先检查原因再恢复。"}</p>
            </div>
          </div>
          <ol className="recovery-steps">
            {advice.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p className="muted">
            已完成的副本和断点保留。不自动改写
            UUID、不格式化磁盘、不删除素材，也不会把“路径可访问”当成“校验通过”。
          </p>
          <Button kind="subtle" disabled={busy} onClick={() => void inspect()}>
            <RefreshCw size={15} />
            {busy
              ? "正在安全检查…"
              : report
                ? "重新只读检查"
                : "只读检查连接与身份"}
          </Button>
          {report && (
            <div className="recovery-checks" aria-live="polite">
              <p className="muted">
                检查时间：{new Date(report.checkedAt).toLocaleTimeString()} ·
                未重新哈希素材
              </p>
              {report.checks.map((check, index) => (
                <article
                  key={index}
                  className={check.blocking ? "needs-attention" : ""}
                >
                  <header>
                    {check.blocking ||
                    check.status === "unavailable" ||
                    check.status === "changed" ? (
                      <AlertTriangle size={17} />
                    ) : (
                      <CheckCircle2 size={17} />
                    )}
                    <strong>
                      {check.role === "source"
                        ? "素材源"
                        : `目的地 · ${check.label}`}
                    </strong>
                    <span>{check.blocking ? "先处理此项" : "预检信息"}</span>
                  </header>
                  <p className="mono">{check.path}</p>
                  <p>{check.note}</p>
                  <dl>
                    <dt>记录身份</dt>
                    <dd>
                      {check.expectedUuid || check.expectedId || "尚未记录"}
                    </dd>
                    <dt>当前 UUID</dt>
                    <dd>{check.current?.uuid || "未取得 UUID"}</dd>
                    <dt>实际挂载点</dt>
                    <dd>{check.current?.mountPoint || "未确定"}</dd>
                    {check.freeBytes !== undefined && (
                      <>
                        <dt>当前可用空间</dt>
                        <dd>{bytes(check.freeBytes)}</dd>
                      </>
                    )}
                  </dl>
                  <Button
                    kind="subtle"
                    onClick={() =>
                      void api
                        .reveal(check.current?.mountPoint || check.path)
                        .catch((e) => setError(readableOperationError(e)))
                    }
                  >
                    <FolderOpen size={14} />在 Finder 中查看
                  </Button>
                </article>
              ))}
              <p>{report.explanation}</p>
              {report.canRetry && (
                <label className="recovery-confirm">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已核对来源和目的地，允许重新预检并仅重试未通过目标。
                </label>
              )}
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button kind="subtle" disabled={busy} onClick={onClose}>
            关闭
          </Button>
          <div className="row">
            {!native ? (
              <Button kind="primary" disabled={busy} onClick={onExternal}>
                <ShieldCheck size={15} />
                进入接管校验
              </Button>
            ) : (
              <>
                <Button
                  kind="subtle"
                  disabled={busy}
                  onClick={() =>
                    onNewTask(
                      report?.checks.find((c) => c.role === "source")
                        ?.blocking === false
                        ? task.sourcePath
                        : undefined,
                    )
                  }
                >
                  <Plus size={15} />
                  另建备份任务
                </Button>
                <Button
                  kind="primary"
                  disabled={busy || !report?.canRetry || !confirmed}
                  onClick={() => void recover()}
                >
                  <RefreshCw size={15} />
                  重试未通过目标
                </Button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
