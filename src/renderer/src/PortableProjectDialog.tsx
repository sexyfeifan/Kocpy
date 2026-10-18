import { useEffect, useState } from "react";
import { FileCheck2, FolderOpen, RefreshCw, X } from "lucide-react";
import {
  api,
  bytes,
  type ProjectConfig,
  type ArchiveTransferTaskSummary,
} from "./api";
import { Button } from "./Ui";
import { readableOperationError } from "../../common/interaction";
import { portableProvenanceText } from "../../common/portable-project";

export function PortableProjectDialog({
  project,
  onClose,
}: {
  project: ProjectConfig;
  onClose: () => void;
}) {
  const [root, setRoot] = useState(""),
    [operator, setOperator] = useState(""),
    [reason, setReason] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [acknowledged, setAcknowledged] = useState(false),
    [preview, setPreview] = useState<Awaited<
      ReturnType<typeof api.preparePortableProject>
    > | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [limit, setLimit] = useState(100),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [saved, setSaved] = useState(false),
    [progress, setProgress] = useState<
      Parameters<Parameters<typeof api.onPortableProgress>[0]>[0] | null
    >(null);
  useEffect(() => api.onPortableProgress(setProgress), []);
  const choose = async () => {
    try {
      const chosen = await api.selectDirectory(project.destinationPaths?.[0]);
      if (chosen) {
        setSaved(false);
        setRoot(chosen);
        setPreview(null);
        setSelected([]);
        setAcknowledged(false);
        setMessage("");
        setProgress(null);
      }
    } catch (e) {
      setMessage(readableOperationError(e));
    }
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(readableOperationError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal portable-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="portable-title"
        data-dirty-tracking="inputs"
        data-submitted={saved ? "true" : undefined}
      >
        <header className="modal-header">
          <div>
            <h2 id="portable-title">
              <FileCheck2 size={20} /> 随盘项目文件
            </h2>
            <p>{project.name} · 历史补生成 / 范围修订</p>
          </div>
          <Button
            kind="icon"
            title="关闭随盘项目文件"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </Button>
        </header>
        <div className="form-body portable-project-body">
          <p className="notice">
            请选择备份中的项目根目录，不是源卡。只写入 .kocpyproject
            与追加修订记录，不修改素材、原 MHL
            或历史报告。核对会完整读取文件，大项目可能需要较长时间。
          </p>
          <div className="portable-project-controls">
            <Button kind="subtle" disabled={busy} onClick={() => void choose()}>
              <FolderOpen size={15} /> 选择备份项目根目录
            </Button>
            <p className="mono path-text">{root || "尚未选择"}</p>
            <Button
              disabled={!root || busy}
              onClick={() =>
                void run(async () => {
                  setSaved(false);
                  setPreview(null);
                  setSelected([]);
                  setAcknowledged(false);
                  setProgress(null);
                  const p = await api.preparePortableProject(root, project.id);
                  setPreview(p);
                  setLimit(100);
                })
              }
            >
              <RefreshCw size={15} /> 只读核对全部文件
            </Button>
          </div>
          {progress && (
            <div className="portable-project-progress" aria-live="polite">
              <progress
                value={progress.bytes}
                max={Math.max(1, progress.totalBytes)}
              />
              <p>
                {progress.files} / {progress.totalFiles} 文件 ·{" "}
                {bytes(progress.bytes)} / {bytes(progress.totalBytes)}
              </p>
              <p className="mono path-text">{progress.currentFile}</p>
            </div>
          )}
        {busy && !preview && (
            <Button
              kind="subtle"
              onClick={() => void api.cancelPortableProject()}
            >
              取消核对（不提交新基线）
            </Button>
          )}
          {preview && (
            <>
              <div className="notice">
                <strong>{portableProvenanceText(preview.provenance!)}</strong>
                <p>
                  {preview.currentFiles} 文件 · {bytes(preview.currentBytes)} ·
                  原任务摘要 {preview.rolls.length} 卷 · 已有有意排除{" "}
                  {preview.exclusions} 项
                </p>
                <p>
                  首次基线只能证明现在能读到的内容，不能追溯证明历史原卡齐全。发现内容/大小差异时不能通过确认消除。
                </p>
              </div>
              {preview.mismatches.length > 0 && (
                <div role="alert" className="notice error-text">
                  <strong>
                    {preview.mismatches.length}{" "}
                    项内容或大小异常：先核对健康副本，禁止提交
                  </strong>
                  {preview.mismatches.slice(0, 100).map((p) => (
                    <p className="mono path-text" key={p}>
                      {p}
                    </p>
                  ))}
                </div>
              )}
              {preview.missing.length > 0 && (
                <div className="portable-missing">
                  <h3>原记录存在、当前缺失 {preview.missing.length} 项</h3>
                  <p>
                    逐项勾选只适用于授权范围内的有意移除。不确定或意外损失时应停止，先补回文件。
                  </p>
                  {preview.missing.slice(0, limit).map((p) => (
                    <label className="portable-missing-row" key={p}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selected.includes(p)}
                        onChange={(e) =>
                          setSelected((s) =>
                            e.target.checked
                              ? [...s, p]
                              : s.filter((v) => v !== p),
                          )
                        }
                      />
                      <span className="mono path-text">{p}</span>
                    </label>
                  ))}
                  {limit < preview.missing.length && (
                    <Button onClick={() => setLimit((n) => n + 100)}>
                      显示后续缺失项
                    </Button>
                  )}
                  <p>
                    已逐项确认 {selected.length} / {preview.missing.length}
                  </p>
                  <label>
                    有意移除原因
                    <textarea
                      value={reason}
                      maxLength={2000}
                      disabled={busy}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                </div>
              )}
              <div className="portable-project-fields">
                <label>
                  实际操作人
                  <input
                    value={operator}
                    maxLength={120}
                    disabled={busy}
                    onChange={(e) => setOperator(e.target.value)}
                  />
                </label>
                <label>
                  输入项目名称确认范围
                  <input
                    value={confirmation}
                    disabled={busy}
                    onChange={(e) => setConfirmation(e.target.value)}
                    placeholder={project.name}
                  />
                </label>
              </div>
              <label className="portable-missing-row">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  disabled={busy}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>
                  我确认选择正确；新范围修订保留原始证据，不代表原始整卡齐全，也不授权格式化原卡。
                </span>
              </label>
              <Button
                kind="primary"
                disabled={
                  busy ||
                  !operator.trim() ||
                  !acknowledged ||
                  confirmation !== project.name ||
                  preview.mismatches.length > 0 ||
                  selected.length !== preview.missing.length ||
                  Boolean(selected.length && !reason.trim())
                }
                onClick={() =>
                  void run(async () => {
                    const result = await api.publishPortableProject({
                      previewId: preview.previewId,
                      operator,
                      missing: selected,
                      reason,
                      confirmation,
                    });
                    if (result) {
                      setSaved(true);
                      setPreview(null);
                      setMessage(
                        `随盘项目文件已保存。修订 ${result.revision}；可随备份盘在另一台 Mac 继承项目。`,
                      );
                    }
                  })
                }
              >
                保存随盘项目文件{selected.length ? "与有意移除修订" : ""}
              </Button>
            </>
          )}
          {message && (
            <p className="notice path-text" role="alert">
              {message}
            </p>
          )}
          <p className="muted small">
            若异常退出留下
            .kocpyproject.lock，请保留目录并检查后台记录，不要直接删除锁来强行继续。可重新启动后确认无写入任务，再由诊断流程处理。
          </p>
        </div>
        <footer className="modal-footer">
          <Button disabled={busy} onClick={onClose}>
            关闭
          </Button>
        </footer>
      </section>
    </div>
  );
}

export function PortableProjectHistory({
  project,
}: {
  project: ProjectConfig;
}) {
  const [transfers, setTransfers] = useState<ArchiveTransferTaskSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const reload = () =>
      void api
        .getArchiveTransfers()
        .then((t) => {
          setTransfers(t);
          setError("");
        })
        .catch((e) => setError(readableOperationError(e)));
    reload();
    return api.onWorkspaceChanged(reload);
  }, [project.id]);
  const history = project.portableHistory?.at(-1),
    linked = transfers.filter((t) => t.projectId === project.id);
  if (!history && !linked.length && !error) return null;
  return (
    <section className="portable-history">
      <h3>随盘历史与归档转存</h3>
      {error && (
        <p role="alert" className="error-text path-text">
          无法刷新归档记录：{error}
          。请重新打开项目详情或到归档维护查看，不能据此认定没有转存历史。
        </p>
      )}
      {history && (
        <>
          <p>
            {history.project.name} · 随盘历史 {history.rolls.length} 卷 ·{" "}
            {history.files} 文件 · {bytes(history.bytes)} · 有意排除{" "}
            {history.exclusions} 项
          </p>
          <p className="muted small">
            {history.provenance === "current-baseline"
              ? "当前范围首次基线；历史原卡完整性未知。"
              : "引用原工作站记录；不计入本机传输、整卡完成或独立副本统计。"}{" "}
            导入人 {history.operator}；修订 {history.revision}
          </p>
          <details>
            <summary>查看原工作站素材卷摘要（{history.rolls.length}）</summary>
            {history.rolls.slice(0, 100).map((r) => (
              <div className="portable-history-row" key={r.id}>
                <strong>{r.name}</strong>
                <span>
                  {r.dates.join("、") || "日期未记录"} · {r.devices.join("、")}
                </span>
                <span>
                  {r.files} 文件 · {bytes(r.bytes)} · {r.scope}
                </span>
              </div>
            ))}
            {history.rolls.length > 100 && (
              <p>
                这里只展示前100卷，完整记录保留在随盘文件与项目 JSON 导出中。
              </p>
            )}
          </details>
        </>
      )}
      {linked.map((t) => (
        <div className="portable-history-row" key={t.id}>
          <strong>
            {t.archiveName} ·{" "}
            {t.status === "completed" ? "本次转存内容校验通过" : "转存尚未完成"}
          </strong>
          <span className="mono path-text">{t.finalPath}</span>
          <span>
            {t.inventory.totalFiles} 文件 · {bytes(t.inventory.totalBytes)} ·
            报告 {t.reportStatus === "completed" ? "已生成" : "待完成"}
          </span>
        </div>
      ))}
    </section>
  );
}
