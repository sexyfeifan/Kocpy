import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  FileClock,
  FolderInput,
  FolderOutput,
  Gauge,
  LoaderCircle,
} from "lucide-react";
import { bytes, type BackgroundActivitySummary, type ProjectConfig } from "./api";
import { Button, Empty } from "./Ui";

const kindLabels: Record<BackgroundActivitySummary["kind"], string> = {
  transfer: "素材备份",
  proxy: "代理处理",
  "archive-transfer": "归档转存",
  maintenance: "后台维护",
};

const phaseLabels: Record<string, string> = {
  scanning: "扫描范围",
  hashing: "读取源文件",
  copying: "复制数据",
  publishing: "提交文件",
  verifying: "目标独立回读",
  reporting: "生成报告",
  benchmarking: "磁盘性能预检",
  "validating-media": "介质可靠性测试",
  completed: "已完成",
  attention: "需要处理",
  queued: "等待处理",
  "validating-source": "检查源文件",
  transcoding: "生成代理",
  "validating-output": "检查代理文件",
  ready: "准备完成",
  failed: "失败",
};

const stateLabels: Record<BackgroundActivitySummary["state"], string> = {
  running: "进行中",
  attention: "待处理",
  completed: "已完成",
  failed: "失败",
};

const duration = (seconds: number) => {
  if (!seconds) return "";
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} 小时`;
};

function ActivityProgress({ activity }: { activity: BackgroundActivitySummary }) {
  const percent = Math.round(Math.max(0, Math.min(1, activity.progress)) * 100),
    filePercent = activity.currentFileTotalBytes
      ? Math.round(
          Math.max(
            0,
            Math.min(1, activity.currentFileBytes / activity.currentFileTotalBytes),
          ) * 100,
        )
      : 0;
  return (
    <div className="background-progress">
      <div className="background-progress-head">
        <span>{phaseLabels[activity.phase] || activity.phase}</span>
        <b>{percent}%</b>
      </div>
      <progress max={100} value={percent} aria-label={`${activity.name} 总体进度`} />
      <div className="background-progress-meta">
        <span>
          {activity.totalBytes
            ? `${bytes(activity.completedBytes)} / ${bytes(activity.totalBytes)}`
            : stateLabels[activity.state]}
          {activity.totalFiles > 0
            ? ` · ${activity.completedFiles.toLocaleString()} / ${activity.totalFiles.toLocaleString()} 个文件`
            : ""}
        </span>
        <span>
          {activity.speedBps ? `${bytes(activity.speedBps)}/s` : "正在计算速度"}
          {activity.etaSeconds ? ` · 约剩 ${duration(activity.etaSeconds)}` : ""}
        </span>
      </div>
      {activity.currentFile && (
        <div className="background-current-file">
          <span title={activity.currentFile}>{activity.currentFile}</span>
          {activity.currentFileTotalBytes > 0 && (
            <>
              <progress
                max={100}
                value={filePercent}
                aria-label={`${activity.currentFile} 文件进度`}
              />
              <small>
                当前文件 {bytes(activity.currentFileBytes)} /{" "}
                {bytes(activity.currentFileTotalBytes)} · {filePercent}%
              </small>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function BackgroundActivityOverview({
  activities,
  onOpen,
}: {
  activities: BackgroundActivitySummary[];
  onOpen: (activity?: BackgroundActivitySummary) => void;
}) {
  const active = activities.filter((item) =>
    ["running", "attention"].includes(item.state),
  );
  return (
    <section className="panel background-overview">
      <div className="section-title">
        <div>
          <h2>
            <Activity size={18} /> 后台活动
          </h2>
          <span className="muted small">备份、代理、归档与维护任务实时状态</span>
        </div>
        <Button kind="subtle" onClick={() => onOpen(active[0])}>
          查看全部 <ArrowRight size={14} />
        </Button>
      </div>
      {!active.length ? (
        <div className="background-idle">
          <CheckCircle2 size={16} /> 当前没有运行中或待处理的后台任务
        </div>
      ) : (
        <div className="background-overview-list">
          {active.map((activity) => (
            <button key={activity.id} onClick={() => onOpen(activity)}>
              <span className={`background-kind ${activity.state}`}>
                {activity.state === "running" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <AlertTriangle size={16} />
                )}
              </span>
              <div>
                <strong>{activity.name}</strong>
                <small>
                  {kindLabels[activity.kind]} ·{" "}
                  {phaseLabels[activity.phase] || activity.phase}
                  {activity.projectName ? ` · ${activity.projectName}` : ""}
                </small>
                <ActivityProgress activity={activity} />
              </div>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function BackgroundTasksPage({
  activities,
  notices,
  projects,
  focusId,
  onOpenRoute,
}: {
  activities: BackgroundActivitySummary[];
  notices: Array<{ message: string; error: boolean }>;
  projects: ProjectConfig[];
  focusId?: string;
  onOpenRoute: (activity: BackgroundActivitySummary) => void;
}) {
  const [state, setState] = useState("all"),
    [kind, setKind] = useState("all"),
    [projectId, setProjectId] = useState("");
  const visible = useMemo(
    () =>
      activities.filter(
        (item) =>
          (state === "all" || item.state === state) &&
          (kind === "all" || item.kind === kind) &&
          (!projectId || item.projectId === projectId),
      ),
    [activities, kind, projectId, state],
  );
  useEffect(() => {
    if (!focusId) return;
    requestAnimationFrame(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-background-id]"),
      ).find((element) => element.dataset.backgroundId === focusId);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [focusId, visible]);
  return (
    <>
      <section className="panel background-filters">
        <div className="tabs" role="group" aria-label="后台任务状态">
          {[
            ["all", "全部"],
            ["running", "进行中"],
            ["attention", "待处理"],
            ["completed", "已完成"],
            ["failed", "失败"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={state === id}
              className={state === id ? "active" : ""}
              onClick={() => setState(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="row">
          <select aria-label="后台任务类型" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">全部任务类型</option>
            <option value="transfer">素材备份</option>
            <option value="proxy">代理处理</option>
            <option value="archive-transfer">归档转存</option>
            <option value="maintenance">后台维护</option>
          </select>
          <select aria-label="后台任务项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}{project.status === "archived" ? "（已归档）" : ""}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="panel background-task-list">
        {!visible.length ? (
          <Empty icon={FileClock} title="当前范围没有后台任务" detail="调整状态、类型或项目筛选后再查看。" />
        ) : (
          visible.map((activity) => (
            <article
              key={activity.id}
              data-background-id={activity.id}
              className={`background-task ${activity.state}`}
            >
              <div className="background-task-title">
                <span>
                  {activity.state === "running" ? <LoaderCircle size={18} className="spin" /> : activity.state === "completed" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                  <strong>{activity.name}</strong>
                </span>
                <b>{stateLabels[activity.state]}</b>
              </div>
              <p>
                {kindLabels[activity.kind]} · {phaseLabels[activity.phase] || activity.phase}
                {activity.projectName ? ` · ${activity.projectName}` : ""}
              </p>
              <ActivityProgress activity={activity} />
              <div className="background-paths">
                {activity.sourcePath && <span><FolderInput size={14} /><code title={activity.sourcePath}>{activity.sourcePath}</code></span>}
                {activity.destinationPath && <span><FolderOutput size={14} /><code title={activity.destinationPath}>{activity.destinationPath}</code></span>}
              </div>
              <div className="background-timing">
                <span><Clock3 size={13} />开始：{new Date(activity.startedAt).toLocaleString()}</span>
                {activity.completedAt && <span>结束：{new Date(activity.completedAt).toLocaleString()}</span>}
                {activity.elapsedMs > 0 && <span>用时：{duration(activity.elapsedMs / 1000)}</span>}
                {activity.averageSpeedBps > 0 && <span><Gauge size={13} />平均 {bytes(activity.averageSpeedBps)}/s</span>}
              </div>
              <div className="background-timeline" aria-label="执行时间线">
                <span><i />任务开始</span>
                <span className={activity.state === "running" ? "current" : ""}>
                  <i />{phaseLabels[activity.phase] || activity.phase}
                </span>
                {activity.completedAt && (
                  <span className={activity.state}><i />{stateLabels[activity.state]}</span>
                )}
              </div>
              {activity.result && <p className="green-text">{activity.result}</p>}
              {activity.error && <p className="red-text" role="alert">{activity.error}</p>}
              <div className="row">
                <Button kind="subtle" onClick={() => onOpenRoute(activity)}>
                  打开原功能 <ArrowRight size={14} />
                </Button>
              </div>
            </article>
          ))
        )}
      </section>
      {notices.length > 0 && (
        <section className="panel background-messages">
          <div className="section-title">
            <div>
              <h2>本次运行操作消息</h2>
              <span className="muted small">当前软件运行期间产生的即时结果与提示</span>
            </div>
            <span>{notices.length} 条</span>
          </div>
          {[...notices].reverse().map((notice, index) => (
            <p key={`${index}-${notice.message}`} className={notice.error ? "red-text" : ""}>
              {notice.message}
            </p>
          ))}
        </section>
      )}
    </>
  );
}
