import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  FileDown,
  FolderInput,
  FolderOutput,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { Button, Empty } from "./Ui";
import {
  api,
  bytes,
  type ArchiveTransferPreviewSummary,
  type ArchiveTransferProgress,
  type ArchiveTransferTaskSummary,
  type ProjectConfig,
} from "./api";
import { readableOperationError } from "../../common/interaction";

const statusText: Record<ArchiveTransferTaskSummary["status"], string> = {
  ready: "准备中",
  running: "正在复制",
  verifying: "正在独立回读",
  interrupted: "已中断，可恢复",
  failed: "未完成",
  completed: "数据校验通过",
};

function DropDirectory({
  title,
  detail,
  value,
  icon: Icon,
  onChoose,
  onDrop,
  disabled,
}: {
  title: string;
  detail: string;
  value: string;
  icon: typeof FolderInput;
  onChoose: () => void;
  onDrop: (files: File[]) => void;
  disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`archive-transfer-drop ${over ? "is-over" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!disabled) onDrop(Array.from(event.dataTransfer.files));
      }}
    >
      <Icon size={23} />
      <div>
        <strong>{title}</strong>
        <span>{value || detail}</span>
      </div>
      <Button kind="subtle" disabled={disabled} onClick={onChoose}>
        选择文件夹
      </Button>
    </div>
  );
}

export function ArchiveTransferPanel({
  projects,
  initialProjectId,
  notify,
}: {
  projects: ProjectConfig[];
  initialProjectId?: string;
  notify: (message: string, error?: boolean) => void;
}) {
  const [sourcePath, setSourcePath] = useState(""),
    [destinationParent, setDestinationParent] = useState(""),
    [projectId, setProjectId] = useState(initialProjectId || ""),
    [preview, setPreview] = useState<ArchiveTransferPreviewSummary | null>(null),
    [tasks, setTasks] = useState<ArchiveTransferTaskSummary[]>([]),
    [progress, setProgress] = useState<Record<string, ArchiveTransferProgress>>(
      {},
    ),
    [busy, setBusy] = useState<string | null>(null),
    [message, setMessage] = useState("");
  const reload = useCallback(
    () => api.getArchiveTransfers().then(setTasks),
    [],
  );
  useEffect(() => {
    void reload().catch((error) => notify(readableOperationError(error), true));
    return api.onArchiveTransferProgress((value) =>
      setProgress((current) => ({ ...current, [value.taskId]: value })),
    );
  }, [reload, notify]);
  useEffect(() => setPreview(null), [sourcePath, destinationParent, projectId]);

  const pick = async (
    current: string,
    update: (value: string) => void,
  ) => {
    const value = await api.selectDirectory(current || undefined);
    if (value) update(value);
  };
  const dropped = async (files: File[], update: (value: string) => void) => {
    try {
      const paths = api.resolveDroppedPaths(files),
        directories = await api.validateDirectories(paths);
      if (directories.length !== 1) throw new Error("每一步请只拖入一个文件夹");
      update(directories[0]);
    } catch (error) {
      notify(readableOperationError(error), true);
    }
  };
  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setMessage("");
    try {
      await action();
      await reload();
    } catch (error) {
      const value = readableOperationError(error);
      setMessage(value);
      notify(value, true);
    } finally {
      setBusy(null);
    }
  };
  const latest = useMemo(() => tasks.slice(0, 8), [tasks]);
  return (
    <section className="panel archive-transfer-panel" id="archive-transfer-panel">
      <div className="section-title">
        <div>
          <h2>
            <FolderOutput size={18} /> 独立归档转存到 NAS
          </h2>
          <span className="muted small">
            完整扫描实际文件夹，复制后从 NAS 独立回读 SHA-256；不删除本地源，也不计入素材卡统计
          </span>
        </div>
        <span className="archive-transfer-safety">不覆盖同名目标</span>
      </div>

      {message && (
        <p className="notice" role="alert">
          {message}
        </p>
      )}
      <div className="archive-transfer-steps" aria-label="NAS 归档转存四步">
        <div className="archive-transfer-step">
          <b>1</b>
          <DropDirectory
            title="选择源项目文件夹"
            detail="可拖入普通文件夹，不要求先建立拍摄项目"
            value={sourcePath}
            icon={FolderInput}
            disabled={busy !== null}
            onChoose={() => void pick(sourcePath, setSourcePath)}
            onDrop={(files) => void dropped(files, setSourcePath)}
          />
        </div>
        <div className="archive-transfer-step">
          <b>2</b>
          <DropDirectory
            title="选择已挂载 NAS 的父目录"
            detail="最终目录会保留源根文件夹名称"
            value={destinationParent}
            icon={FolderOutput}
            disabled={busy !== null}
            onChoose={() => void pick(destinationParent, setDestinationParent)}
            onDrop={(files) => void dropped(files, setDestinationParent)}
          />
        </div>
        <div className="archive-transfer-step archive-transfer-plan-step">
          <b>3</b>
          <div className="archive-transfer-plan">
            <label>
              关联项目信息（可选，只用于名称、日期和历史证据）
              <select
                value={projectId}
                disabled={busy !== null}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">普通文件夹，不关联项目</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            {!preview ? (
              <Button
                kind="primary"
                disabled={!sourcePath || !destinationParent || busy !== null}
                onClick={() =>
                  void run("preview", async () => {
                    const value = await api.previewArchiveTransfer({
                      sourcePath,
                      destinationParent,
                      projectId: projectId || undefined,
                    });
                    setPreview(value);
                    setMessage("预检完成。请核对实际最终目标后再开始。");
                  })
                }
              >
                {busy === "preview" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <ShieldCheck size={14} />
                )}
                预检范围与目标
              </Button>
            ) : (
              <div className="archive-transfer-preview">
                <div>
                  <span>归档名称</span>
                  <strong>{preview.archiveName}</strong>
                  <small>
                    {preview.archiveNameSource === "project"
                      ? "来自项目记录"
                      : "来自源文件夹名称"}
                    · 拍摄日期 {preview.shootingDate || "未记录"}
                  </small>
                </div>
                <div>
                  <span>本次 payload</span>
                  <strong>
                    {preview.inventory.totalFiles.toLocaleString()} 个文件 ·{" "}
                    {bytes(preview.inventory.totalBytes)}
                  </strong>
                  <small>
                    精确 {preview.inventory.totalBytes.toLocaleString()} 字节 ·{" "}
                    {preview.inventory.emptyDirectoryCount} 个空目录
                  </small>
                </div>
                <div className="archive-transfer-final-path">
                  <span>实际最终 NAS 目标</span>
                  <strong className="mono">{preview.finalPath}</strong>
                </div>
                {preview.warnings.map((warning) => (
                  <p key={warning} className="archive-transfer-warning">
                    {warning}
                  </p>
                ))}
                <p className="archive-transfer-boundary">
                  {preview.evidenceBoundary}
                </p>
                <div className="row">
                  <Button kind="subtle" onClick={() => setPreview(null)}>
                    重新预检
                  </Button>
                  <Button
                    kind="primary"
                    disabled={busy !== null}
                    onClick={() =>
                      void run("start", async () => {
                        const result = await api.startArchiveTransfer({
                          sourcePath,
                          destinationParent,
                          projectId: projectId || undefined,
                          previewDigest: preview.inventory.digest,
                        });
                        setPreview(null);
                        const success = result.reportStatus === "completed";
                        const text = success
                          ? "NAS 归档转存、独立回读与 PDF/PNG 报告已完成"
                          : "数据已校验，但报告保存失败；可在结果中单独重试";
                        setMessage(text);
                        notify(text, !success);
                      })
                    }
                  >
                    {busy === "start" ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Play size={14} />
                    )}
                    开始转存
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="archive-transfer-step archive-transfer-results-step">
          <b>4</b>
          <div className="archive-transfer-results">
            <h3>完成并查看结果</h3>
            {!latest.length ? (
              <Empty
                icon={FolderOutput}
                title="还没有归档转存"
                detail="完成前三步后，这里会保留独立任务与恢复状态。"
              />
            ) : (
              latest.map((task) => {
                const live = progress[task.id],
                  completed = live?.completedFiles ?? task.completedFiles,
                  total = live?.totalFiles ?? task.inventory.totalFiles,
                  percent = total ? Math.round((completed / total) * 100) : 100,
                  report = task.reportAttempts
                    .filter((item) => item.status === "completed")
                    .at(-1);
                return (
                  <article className="archive-transfer-result" key={task.id}>
                    <div className="archive-transfer-result-head">
                      <span>
                        {task.status === "completed" ? (
                          <CheckCircle2 size={17} />
                        ) : live || task.status === "running" ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <RotateCcw size={17} />
                        )}
                        <strong>{task.archiveName}</strong>
                      </span>
                      <small>{statusText[live?.status || task.status]}</small>
                    </div>
                    <div className="archive-transfer-progress">
                      <i style={{ width: `${percent}%` }} />
                    </div>
                    <p className="mono">{task.finalPath}</p>
                    <small>
                      {task.inventory.totalFiles.toLocaleString()} 个文件 ·{" "}
                      {task.inventory.totalBytes.toLocaleString()} 字节 · 报告{" "}
                      {task.reportStatus === "completed"
                        ? "已生成"
                        : task.reportStatus === "failed"
                          ? "待重试"
                          : "等待生成"}
                    </small>
                    {task.error && <p className="archive-transfer-error">{task.error}</p>}
                    <div className="row">
                      {task.status === "interrupted" && (
                        <Button
                          kind="primary"
                          disabled={busy !== null}
                          onClick={() =>
                            void run(`resume-${task.id}`, async () => {
                              const result = await api.resumeArchiveTransfer(task.id);
                              notify(
                                result.reportStatus === "completed"
                                  ? "原归档任务已恢复并完成"
                                  : "原归档数据已恢复并校验，报告仍需重试",
                                result.reportStatus !== "completed",
                              );
                            })
                          }
                        >
                          {busy === `resume-${task.id}` ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                          核对身份并恢复
                        </Button>
                      )}
                      {task.status === "completed" &&
                        task.reportStatus !== "completed" && (
                          <Button
                            kind="subtle"
                            disabled={busy !== null}
                            onClick={() =>
                              void run(`report-${task.id}`, async () => {
                                await api.retryArchiveTransferReports(task.id);
                                notify("PDF 与高清 PNG 报告已重新生成");
                              })
                            }
                          >
                            <FileDown size={14} /> 生成/重试报告（不重新复制）
                          </Button>
                        )}
                      {task.status === "completed" && (
                        <Button
                          kind="subtle"
                          onClick={() => void api.reveal(task.finalPath)}
                        >
                          <FolderOutput size={14} /> 查看 NAS 归档
                        </Button>
                      )}
                      {report?.pdfPath && (
                        <Button
                          kind="subtle"
                          onClick={() => void api.reveal(report.pdfPath!)}
                        >
                          <FileDown size={14} /> 查看报告
                        </Button>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
