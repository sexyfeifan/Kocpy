import { RecoveryDialog } from "./RecoveryDialog";
import { recoveryAdvice } from "../../common/recovery";
import { LifecycleControls } from "./LifecycleControls";
import { OperationCenter, useModalStack } from "./Interaction";
import { readableOperationError, didComplete } from "../../common/interaction";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  selectLiveTask,
  transferPhaseText,
  transferTiming,
  transferProgressLabel,
} from "./task-state";
import {
  LayoutDashboard,
  ArrowLeftRight,
  FolderKanban,
  Film,
  FileCheck2,
  HardDrive,
  Settings2,
  Plus,
  ArrowUpRight,
  ArrowRight,
  ChevronRight,
  ChevronLeft,
  Check,
  CheckCheck,
  ShieldCheck,
  FolderOpen,
  Search,
  X,
  RefreshCw,
  Play,
  Square,
  Clock,
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  MoreHorizontal,
  FolderPlus,
  MemoryStick,
  Monitor,
  Usb,
  LogOut as Eject,
  Copy,
  Download,
  Upload,
  Archive,
  CalendarDays,
  Layers,
  SlidersHorizontal,
  Sun,
  Moon,
  Command,
  Info,
  File,
  Clapperboard,
  Eye,
  ExternalLink,
  Trash2,
  ChevronsUp,
  Activity,
  Pause,
  Code2,
  Gauge,
  PackageSearch,
  PackageCheck,
  Wifi,
  Database,
  Share2,
  CircleHelp,
  BookOpen,
  ScanLine,
  Camera,
  AudioWaveform,
  Bell,
  FileDown,
} from "lucide-react";
import {
  api,
  bytes,
  leaf,
  date,
  today,
  active,
  statusText,
  type BackupTask,
  type ProjectConfig,
  type Volume,
  type Settings,
  type Scan,
  type ProxyJob,
  type SavedProxyPreset,
  type UpdateInfo,
  type TransferPerformance,
  type ExistingImportPreview,
  type ExistingCandidateDecision,
  type ExistingImportProgress,
  type CompletionActionKind,
  type WorkspaceImportPreview,
} from "./api";
import { Composer } from "./Composer";
import { ProjectEditor } from "./ProjectEditor";
import { WorkstationImportDialog } from "./WorkstationImportDialog";
import {
  TemplateApplyDialog,
  TemplateEditor,
  projectTemplateDraft,
} from "./TemplateEditor";
import {
  projectCellStatus,
  projectCloseoutSummary,
  projectDeviceCells,
  verifiedPhysicalCopyCount,
  taskMeetsCopyRequirement,
  manifestRequirementMet,
} from "../../main/project-closeout";
import { taskMediaKind } from "../../main/media-kind";
import { copyEvidenceSummary } from "../../common/copy-evidence";
import { APP_VERSION } from "../../common/version";
import {
  taskTrustState,
  projectCoverage,
  savedDestinationBytes,
} from "../../common/task-trust";
import { projectDates, shootingDateKey } from "../../common/shooting-dates";
import { groupLogicalVolumes } from "../../common/logical-volumes";
import { Badge, Button, Empty } from "./Ui";
import { modalDialogSelector } from "../../common/dialog";

export { Badge, Button, Empty } from "./Ui";

type Page =
  | "overview"
  | "transfers"
  | "recovery"
  | "projects"
  | "library"
  | "processing"
  | "reports"
  | "storage"
  | "diagnostics"
  | "maintenance"
  | "help"
  | "settings";
const navigation: [Page, string, typeof LayoutDashboard][] = [
  ["overview", "工作台", LayoutDashboard],
  ["projects", "拍摄项目", FolderKanban],
  ["transfers", "传输队列", ArrowLeftRight],
  ["recovery", "恢复中心", RefreshCw],
  ["library", "素材库", Film],
  ["processing", "代理队列", Activity],
  ["reports", "报告中心", FileCheck2],
  ["storage", "存储设备", HardDrive],
  ["maintenance", "归档维护", Database],
  ["diagnostics", "诊断中心", Gauge],
  ["help", "使用说明", CircleHelp],
];
const readableError = (reason: unknown) =>
  String(reason)
    .replace(/^Error:\s*/i, "")
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
    .replace(/^Error:\s*/i, "");
const defaults: Settings = {
  defaultHash: "sha256",
  defaultDuplicateStrategy: "skip",
  includeHidden: true,
  operator: "",
  theme: "dark",
  reportSyncPath: "",
  thumbnailCacheGiB: 2,
  notificationSound: true,
};
const duration = (seconds = 0) => {
  const value = Math.max(0, Math.round(seconds));
  const h = Math.floor(value / 3600),
    m = Math.floor((value % 3600) / 60),
    s = value % 60;
  return `${h ? `${h}时` : ""}${h || m ? `${String(m).padStart(h ? 2 : 1, "0")}分` : ""}${String(s).padStart(h || m ? 2 : 1, "0")}秒`;
};
const focusProjectMenuTrigger = (projectId: string) =>
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      "[data-project-menu-trigger]",
    ),
  ]
    .find((button) => button.dataset.projectMenuTrigger === projectId)
    ?.focus();
function SpeedSparkline({
  values,
  color = "var(--purple)",
}: {
  values: number[];
  color?: string;
}) {
  const max = Math.max(1, ...values),
    points = (values.length ? values : [0])
      .map(
        (value, index, all) =>
          `${(index / Math.max(1, all.length - 1)) * 100},${28 - (value / max) * 24}`,
      )
      .join(" ");
  return (
    <svg
      className="speed-sparkline"
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-label="最近 30 秒速度曲线"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
const performanceText = (performance?: TransferPerformance) =>
  performance?.samples
    ? `平均 ${bytes(performance.average)}/s · P95 ${bytes(performance.p95)}/s · 峰值 ${bytes(performance.peak)}/s${performance.stalls ? ` · ${performance.stalls} 次停顿` : ""}`
    : "样本不足";
const completionActionLabels: Record<CompletionActionKind, string> = {
  report: "生成校验报告",
  delivery: "生成交付清单",
  proxy: "加入代理队列",
  eject: "安全推出源盘",
};
const completionActionStatus = {
  suggested: "等待确认",
  running: "正在执行",
  completed: "已完成",
  failed: "执行失败",
  skipped: "本任务已跳过",
} as const;
function TaskBadge({ task }: { task: BackupTask }) {
  const trust = taskTrustState(task);
  return (
    <span className={`badge ${trust.status}`} title={trust.explanation}>
      <i />
      {trust.label}
    </span>
  );
}
export function App() {
  useModalStack();
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [maintenanceProjectId, setMaintenanceProjectId] = useState<
    string | undefined
  >();
  const [notices, setNotices] = useState<
    Array<{ message: string; error: boolean }>
  >([]);
  const [taskLimit, setTaskLimit] = useState(100);
  const [completionOperator, setCompletionOperator] = useState("");
  const [dailyPlanOperator, setDailyPlanOperator] = useState("");
  const [dailyPlanDate, setDailyPlanDate] = useState(today());
  const [temporaryDailyDevice, setTemporaryDailyDevice] = useState("");
  const [temporaryDailyPosition, setTemporaryDailyPosition] = useState("");
  const [reportDate, setReportDate] = useState(today()),
    [reportProject, setReportProject] = useState("");

  const [page, setPage] = useState<Page>("overview"),
    [tasks, setTasks] = useState<BackupTask[]>([]),
    [projects, setProjects] = useState<ProjectConfig[]>([]),
    [proxyJobs, setProxyJobs] = useState<ProxyJob[]>([]),
    [volumes, setVolumes] = useState<Volume[]>([]),
    [settings, setSettings] = useState<Settings>(defaults);
  const [composer, setComposer] = useState<{
      source?: string;
      project?: ProjectConfig;
    } | null>(null),
    [editor, setEditor] = useState<Partial<ProjectConfig> | null>(null),
    [existingImport, setExistingImport] = useState<{
      project: ProjectConfig;
      preview: ExistingImportPreview;
    } | null>(null),
    [existingBaseline, setExistingBaseline] = useState<BackupTask | null>(null),
    [manifestIssue, setManifestIssue] = useState<BackupTask | null>(null),
    [detail, setDetail] = useState<string | null>(null),
    [detailTask, setDetailTask] = useState<BackupTask | null>(null),
    [taskCommand, setTaskCommand] = useState<{
      id: string;
      action: "pause" | "resume";
    } | null>(null),
    [projectDetailId, setProjectDetailId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
      message: string;
      error: boolean;
    } | null>(null),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [loading, setLoading] = useState(true),
    [confirm, setConfirm] = useState<{
      text: string;
      run: () => Promise<unknown>;
      actionLabel?: string;
      danger?: boolean;
      requiredText?: string;
      acknowledgement?: string;
      returnFocusId?: string;
    } | null>(null),
    [confirmInput, setConfirmInput] = useState(""),
    [confirmAcknowledged, setConfirmAcknowledged] = useState(false),
    [projectMenuId, setProjectMenuId] = useState<string | null>(null),
    [proxy, setProxy] = useState<{
      path: string;
      name: string;
      paths?: string[];
    } | null>(null),
    [proxyBusy, setProxyBusy] = useState(false),
    [completion, setCompletion] = useState<BackupTask | null>(null),
    [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => setTaskLimit(100), [query, filter]);
  useEffect(() => {
    if (!projectMenuId) return;
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const projectId = projectMenuId;
      setProjectMenuId(null);
      requestAnimationFrame(() => focusProjectMenuTrigger(projectId));
    };
    window.addEventListener("keydown", closeMenu, true);
    return () => window.removeEventListener("keydown", closeMenu, true);
  }, [projectMenuId]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    setConfirmInput("");
    setConfirmAcknowledged(false);
  }, [confirm]);
  useEffect(() => {
    const closeProjectMenu = () => setProjectMenuId(null);
    window.addEventListener("click", closeProjectMenu);
    return () => window.removeEventListener("click", closeProjectMenu);
  }, []);
  const notify = useCallback((message: string, error = false) => {
    message = readableOperationError(message);
    setToast({ message, error });
    setNotices((values) => [...values.slice(-49), { message, error }]);
    clearTimeout(toastTimer.current);
    if (!error) toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);
  const act = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      try {
        const result = await fn();
        if (success && didComplete(result)) notify(success);
      } catch (e) {
        notify(String(e).replace(/^Error: /, ""), true);
      }
    },
    [notify],
  );
  const refresh = useCallback(async () => {
    const [t, p, j] = await Promise.all([
      api.getTasks(),
      api.getProjects(),
      api.getProxyJobs(),
    ]);
    setTasks(t);
    setProjects(p);
    setProxyJobs(j);
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = api.onWorkspaceChanged(() => {
      setWorkspaceRevision((value) => value + 1);
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void refresh().catch((error) =>
            notify(readableOperationError(error), true),
          ),
        150,
      );
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [refresh, notify]);
  useEffect(() => {
    let stopped = false;
    Promise.all([
      api.getTasks(),
      api.getProjects(),
      api.getSettings(),
      api.listVolumes(),
      api.getProxyJobs(),
    ])
      .then(([t, p, s, v, jobs]) => {
        if (!stopped) {
          setTasks(t);
          setProjects(p);
          setSettings({ ...defaults, ...s });
          setVolumes(v);
          setProxyJobs(jobs);
        }
      })
      .catch((e) => notify(String(e), true))
      .finally(() => setLoading(false));
    const unsub = api.onProgress((payload) => {
      setTasks((all) =>
        all.map((t) =>
          t.id === payload.taskId
            ? { ...t, ...payload, fileRecords: t.fileRecords }
            : t,
        ),
      );
      if (["completed", "failed", "cancelled"].includes(payload.status || ""))
        void refresh().catch((e) => notify(String(e), true));
    });
    const unsubProxy = api.onProxyJobs(setProxyJobs);
    const unsubSettled = api.onTaskSettled((task) => {
      setDetailTask((previous) => (previous?.id === task.id ? task : previous));
      if (task.status === "completed") setCompletion(task);
    });
    const interval = setInterval(() => {
      void api
        .listVolumes()
        .then((v) => {
          if (!stopped) setVolumes(v);
        })
        .catch(() => {});
    }, 7000);
    void api
      .checkUpdates()
      .then((info) => {
        if (!stopped) setUpdateInfo(info);
      })
      .catch(() => {});
    return () => {
      stopped = true;
      unsub();
      unsubProxy();
      unsubSettled();
      clearInterval(interval);
    };
  }, [notify, refresh]);
  useEffect(() => {
    if (!detail) {
      setDetailTask(null);
      return;
    }
    let disposed = false;
    void api
      .getCompletionPlan(detail)
      .then(() => api.getTask(detail))
      .then((task) => {
        if (!disposed) setDetailTask(task);
      })
      .catch((error) => {
        if (!disposed) notify(String(error), true);
      });
    return () => {
      disposed = true;
    };
  }, [detail, notify, workspaceRevision]);
  useEffect(() => {
    if (detail) setCompletionOperator(settings.operator || "");
  }, [detail, settings.operator]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const modalOpen = [
        ...document.querySelectorAll<HTMLElement>(modalDialogSelector),
      ].some((node) => node.getClientRects().length > 0);
      if (e.metaKey && e.key.toLowerCase() === "n" && !modalOpen) {
        e.preventDefault();
        setComposer({});
      }
      if (
        e.key === "/" &&
        !modalOpen &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLSelectElement) &&
        !(e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search input")?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const go = (p: Page) => {
    document.querySelector(".page-content")?.scrollTo({ top: 0 });
    setPage(p);
    setQuery("");
    setFilter("all");
  };
  const running = tasks.filter(active),
    finished = tasks.filter((t) => taskTrustState(t).contentVerified),
    current = tasks.find((t) =>
      ["running", "paused", "verifying"].includes(t.status),
    );
  const filtered = tasks.filter(
    (t) =>
      [
        t.name,
        t.sourcePath,
        ...t.destinations.flatMap((destination) => [
          destination.path,
          destination.resolvedPath || "",
        ]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "active" && active(t)) ||
        t.status === filter),
  );
  const selected = selectLiveTask(detail, tasks, detailTask);
  const controlTask = (id: string, action: "pause" | "resume") =>
    act(async () => {
      if (taskCommand) return;
      setTaskCommand({ id, action });
      try {
        if (action === "pause") await api.pauseTask(id);
        else await api.resumeTask(id);
        await refresh();
      } finally {
        setTaskCommand(null);
      }
    });
  const exportReport = (
    id: string,
    format: "pdf" | "json" | "mhl" | "ascmhl",
  ) =>
    act(async () => {
      const result = await api.exportReport(id, format);
      if (result) notify(`报告已保存：${result}`);
    });
  const taskRows = (rows: BackupTask[], compact = false) => (
    <div className="task-list">
      {rows.map((t) => {
        const kind = taskMediaKind(t),
          TaskIcon =
            kind === "video"
              ? Clapperboard
              : kind === "photo"
                ? Camera
                : kind === "audio"
                  ? AudioWaveform
                  : kind === "mixed"
                    ? Layers
                    : MemoryStick;
        return (
          <div
            className="task-row"
            key={t.id}
            role="button"
            tabIndex={0}
            aria-label={`查看任务 ${t.name}，当前状态 ${statusText[t.status] || t.status}`}
            onClick={() => setDetail(t.id)}
            onKeyDown={(event) => {
              if (
                event.target !== event.currentTarget ||
                (event.key !== "Enter" && event.key !== " ")
              )
                return;
              event.preventDefault();
              setDetail(t.id);
            }}
          >
            <span
              className={`file-icon media-${kind} task-${t.status}`}
              title={
                {
                  video: "视频素材",
                  photo: "照片 / RAW 素材",
                  audio: "音频素材",
                  mixed: "混合素材",
                  other: "素材卷",
                }[kind]
              }
            >
              <TaskIcon size={20} />
            </span>
            <div className="task-name">
              <strong>{t.name}</strong>
              <span className="task-meta">
                {leaf(t.sourcePath)} <span className="dot-sep">·</span>{" "}
                {t.destinations.length} 个目的地{" "}
                <span className="dot-sep">·</span>{" "}
                {date(t.startedAt || t.createdAt)}
              </span>
              {!compact && (
                <div className="task-paths">
                  {[
                    { label: "源", path: t.sourcePath, source: true },
                    ...t.destinations.map((destination, index) => ({
                      label: `目的地 ${index + 1}`,
                      path: destination.resolvedPath || destination.path,
                      source: false,
                    })),
                  ].map((item) => (
                    <span
                      className="task-path"
                      key={`${item.label}-${item.path}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`在 Finder 中显示${item.label}：${item.path}`}
                      title={`${item.label}：${item.path}\n点击在 Finder 中显示`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void act(() => api.reveal(item.path));
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        void act(() => api.reveal(item.path));
                      }}
                    >
                      {item.source ? (
                        <MemoryStick size={12} />
                      ) : (
                        <HardDrive size={12} />
                      )}
                      <b>{item.label}</b>
                      <code>{item.path}</code>
                      <FolderOpen size={12} />
                    </span>
                  ))}
                </div>
              )}
            </div>
            {!compact && (
              <span className="task-size">
                {bytes(t.totalBytes)}
                <small>{t.totalFiles} 个文件</small>
              </span>
            )}
            <TaskBadge task={t} />
            <ChevronRight size={16} />
          </div>
        );
      })}
    </div>
  );
  const volumeCard = (v: Volume) => (
    <div className="volume-card" key={v.path}>
      <div className="row between">
        <span className={`device-glyph ${v.deviceType}`}>
          {v.deviceType === "source" ? (
            <MemoryStick size={23} />
          ) : v.deviceType === "system" ? (
            <Monitor size={23} />
          ) : (
            <HardDrive size={23} />
          )}
        </span>
        <span className="device-type">
          {v.deviceType === "source"
            ? "素材介质"
            : v.deviceType === "system"
              ? "内置磁盘"
              : v.deviceType === "network"
                ? "网络存储"
                : "外置 / 挂载存储"}
        </span>
      </div>
      <h3>{v.name}</h3>
      <p className="path" title={v.path}>
        {v.path}
      </p>
      <div className="capacity">
        <i
          style={{
            width: `${Math.min(100, (v.used / Math.max(v.total, 1)) * 100)}%`,
          }}
        />
      </div>
      <div className="row between small">
        <span>{bytes(v.free)} 可用</span>
        <span>{bytes(v.total)}</span>
      </div>
      {v.isNetwork && (
        <div className="row between small">
          <span>
            {v.protocol?.toUpperCase()} · {v.writable ? "可写" : "只读"}
          </span>
          <span>{v.latencyMs} ms 响应</span>
        </div>
      )}
      <div className="volume-actions">
        <Button kind="subtle" onClick={() => setComposer({ source: v.path })}>
          <Plus size={13} />
          用作素材源
        </Button>
        <Button
          kind="icon"
          title="在 Finder 中显示"
          onClick={() => void act(() => api.reveal(v.path))}
        >
          <FolderOpen size={15} />
        </Button>
        {v.canEject && (
          <Button
            kind="icon"
            title="安全推出设备"
            onClick={() =>
              setConfirm({
                text: `安全推出「${v.name}」？请确认其他软件未在使用此磁盘。`,
                run: async () => {
                  await api.ejectVolume(v.path);
                  setVolumes(await api.listVolumes());
                },
              })
            }
          >
            <Eject size={15} />
          </Button>
        )}
      </div>
    </div>
  );
  const saveProject = async (
    p: ProjectConfig,
    createMissing = true,
    operator?: string,
  ) => {
    setProjects(await api.saveProject(p, createMissing, operator));
    setComposer((current) => (current ? { ...current, project: p } : current));
    setEditor(null);
    notify("项目已保存");
  };
  const checkForUpdates = async () => {
    try {
      const info = await api.checkUpdates();
      setUpdateInfo(info);
      if (info.available)
        await api.openUpdate(info.downloadUrl || info.releaseUrl);
      else notify(`Kocpy ${info.current} 已是最新版本`);
    } catch (error) {
      notify(String(error).replace(/^Error: /, ""), true);
    }
  };
  const projectDetail = projects.find(
    (project) => project.id === projectDetailId,
  );
  const projectDetailStart = shootingDateKey(
      projectDetail?.shootingDateStart || projectDetail?.shootingDate,
    ),
    projectDetailEnd = shootingDateKey(
      projectDetail?.shootingDateEnd || projectDetailStart,
    );
  useEffect(() => {
    if (!projectDetailId || !projectDetailStart) return;
    const current = today();
    setDailyPlanDate(
      current >= projectDetailStart && current <= projectDetailEnd
        ? current
        : projectDetailStart,
    );
  }, [projectDetailId, projectDetailStart, projectDetailEnd]);
  const projectDetailTasks = tasks.filter(
    (task) => task.projectId === projectDetailId,
  );
  const projectDetailCloseout = projectDetail
    ? projectCloseoutSummary(
        projectDetail,
        projectDetailTasks,
        projectDates(projectDetail, projectDetailTasks),
      )
    : null;
  const projectDetailLogicalVolumes = projectDetail
    ? groupLogicalVolumes(projectDetailTasks, projectDetail.requiredCopies || 2)
    : [];
  const activeProjectCloseouts = projects
    .filter((project) => project.status !== "archived")
    .map((project) => {
      const related = tasks.filter((task) => task.projectId === project.id),
        dates = projectDates(project, related);
      return {
        project,
        related,
        summary: projectCloseoutSummary(project, related, dates),
      };
    });
  const recoveryTasks = tasks.filter(
    (task) =>
      (!active(task) && !taskTrustState(task).contentVerified) ||
      ["failed", "cancelled", "paused", "pending", "unverified"].includes(
        task.status,
      ) ||
      task.destinations.some(
        (destination) =>
          destination.available === false ||
          Boolean(destination.error) ||
          (!destination.verified &&
            task.status !== "running" &&
            task.status !== "verifying"),
      ),
  );
  const updateProjectSchedule = async (
    project: ProjectConfig,
    dateValue: string,
    device?: string,
    decision: "unused" | "expected" | "clear" = "unused",
  ) => {
    if (!dailyPlanOperator.trim()) {
      notify("请先填写每日计划操作人，再确认设备使用状态", true);
      return false;
    }
    try {
      setProjects(
        await api.updateProjectDailyPlan(project.id, {
          date: dateValue,
          scheduleKey: device,
          decision: device
            ? decision
            : project.restDays?.some(
                  (item) =>
                    shootingDateKey(item) === shootingDateKey(dateValue),
                )
              ? "working"
              : "rest",
          operator: dailyPlanOperator.trim(),
        }),
      );
      notify(
        device
          ? "每日设备使用决定已记录，并保留操作人与时间"
          : "拍摄日状态已记录，并保留操作人与时间",
      );
      return true;
    } catch (error) {
      notify(readableOperationError(error), true);
      return false;
    }
  };
  const requestProjectDeletion = async (project: ProjectConfig) => {
    focusProjectMenuTrigger(project.id);
    setProjectMenuId(null);
    try {
      const preview = await api.previewProjectDeletion(project.id);
      if (!preview.canDelete) {
        notify(
          `项目仍有 ${preview.blockingTasks} 个未结束备份任务和 ${preview.blockingProxyJobs} 个未结束代理任务，请先完成或取消这些任务`,
          true,
        );
        return;
      }
      setConfirm({
        text: `将永久删除「${project.name}」在 Kocpy 内的项目配置、${preview.taskCount} 个任务、${preview.proxyJobCount} 个代理记录、${preview.healthRecordCount} 条健康记录、${preview.archiveRunCount} 次复校验运行、${preview.archiveChangeCount} 条归档变化和 ${preview.reminderCount} 条提醒。不会删除素材文件、备份目录、报告、MHL 或已导出的归档包。`,
        actionLabel: "删除项目记录",
        danger: true,
        requiredText: project.name,
        acknowledgement:
          "我理解此操作只删除 Kocpy 内部记录，且删除后无法在软件内撤销。",
        returnFocusId: `project-menu-${project.id}`,
        run: async () => {
          const result = await api.deleteProject(project.id, project.name);
          setProjects(result.projects);
          setTasks(await api.getTasks());
          if (projectDetailId === project.id) setProjectDetailId(null);
          notify(
            `项目记录已删除：移除 ${result.deletedTasks} 个关联任务；磁盘素材未改动`,
          );
        },
      });
    } catch (error) {
      notify(String(error).replace(/^Error: /, ""), true);
    }
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag" />
        <div className="brand">
          <img src="./icon.png" alt="Kocpy 图标" />
          <div>
            <strong>
              Kocpy<span>{APP_VERSION}</span>
            </strong>
            <small>素材工作台</small>
          </div>
        </div>
        <Button kind="primary new-button" onClick={() => setComposer({})}>
          <Plus size={17} />
          新建备份<span className="key-hint">⌘ N</span>
        </Button>
        <div className="nav-label">工作空间</div>
        <nav aria-label="主要功能">
          {navigation.map(([id, label, Icon]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "selected" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => go(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "transfers" && running.length > 0 ? (
                <b>{running.length}</b>
              ) : page === id ? (
                <span className="nav-marker" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <ShieldCheck size={18} />
            <div>
              <strong>本地优先，安心创作</strong>
              <small>素材与记录留在你的设备</small>
            </div>
          </div>
          <button
            className={`nav-item ${page === "settings" ? "selected" : ""}`}
            aria-current={page === "settings" ? "page" : undefined}
            onClick={() => go("settings")}
          >
            <Settings2 size={18} />
            <span>偏好设置</span>
            {updateInfo?.available && (
              <b title={`发现 Kocpy ${updateInfo.latest}`}>1</b>
            )}
          </button>
          <div className="sidebar-foot">
            <button
              className={`sidebar-update ${updateInfo?.available ? "available" : ""}`}
              title="检查 Kocpy 更新"
              onClick={() => void checkForUpdates()}
            >
              <RefreshCw size={13} />
              <span>
                {updateInfo?.available
                  ? `可升级 ${updateInfo.latest}`
                  : "检查更新"}
              </span>
              <b>v{APP_VERSION}</b>
            </button>
            <div className="sidebar-author-links">
              <span>
                <i className="live-dot" />
                <b>@sexyfeifan</b>
              </span>
              <button
                title="作者 GitHub 主页"
                aria-label="打开作者 GitHub 主页"
                onClick={() =>
                  void api.openAuthor("https://github.com/sexyfeifan")
                }
              >
                <Code2 size={15} />
              </button>
              <button
                title="作者小红书主页"
                aria-label="打开作者小红书主页"
                onClick={() =>
                  void api.openAuthor(
                    "https://www.xiaohongshu.com/user/profile/5d24d2ca000000001103fe97",
                  )
                }
              >
                <img src="./xiaohongshu.png" alt="" />
              </button>
            </div>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            工作空间 <ChevronRight size={13} />
            <strong>
              {page === "settings"
                ? "偏好设置"
                : navigation.find((n) => n[0] === page)?.[1]}
            </strong>
          </div>
          <div className="row">
            <span className="connection">
              <i />
              {volumes.length} 个存储设备在线
            </span>
            <div className="top-divider" />
            <Button
              kind="icon"
              title="刷新任务与设备"
              onClick={() =>
                void act(async () => {
                  await refresh();
                  setVolumes(await api.listVolumes());
                }, "工作台已刷新")
              }
            >
              <RefreshCw size={16} />
            </Button>
            {page !== "help" && (
              <Button
                kind="icon"
                title="本页使用说明"
                onClick={() => {
                  sessionStorage.setItem("kocpy-help-context", page);
                  go("help");
                }}
              >
                <CircleHelp size={17} />
              </Button>
            )}
          </div>
        </header>
        <main key={page} className="page-content">
          <OperationCenter />
          {notices.length > 0 && (
            <details className="notification-history">
              <summary>操作消息（{notices.length}）</summary>
              {[...notices].reverse().map((item, index) => (
                <p key={index} className={item.error ? "red-text" : ""}>
                  {item.message}
                </p>
              ))}
            </details>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {
                  {
                    overview: "YOUR CREATIVE WORKSPACE",
                    transfers: "TRANSFER CENTER",
                    recovery: "RECOVERY CENTER",
                    projects: "PRODUCTION ORGANIZER",
                    library: "VERIFIED MEDIA",
                    processing: "PROXY PROCESSING",
                    reports: "TRANSFER RECORDS",
                    storage: "CONNECTED STORAGE",
                    diagnostics: "RELIABILITY DIAGNOSTICS",
                    maintenance: "ARCHIVE LIFECYCLE",
                    help: "KOCPY USER GUIDE",
                    settings: "MAKE IT YOURS",
                  }[page]
                }
              </div>
              <h1>
                {
                  {
                    overview: "每一份素材，都安心抵达。",
                    transfers: "传输队列",
                    recovery: "恢复中心",
                    projects: "拍摄项目",
                    library: "素材库",
                    processing: "代理队列",
                    reports: "报告中心",
                    storage: "存储设备",
                    diagnostics: "诊断中心",
                    maintenance: "归档维护",
                    help: "软件使用说明书",
                    settings: "偏好设置",
                  }[page]
                }
              </h1>
              <p>
                {
                  {
                    overview: "从现场备份到素材交付，让创作井然有序。",
                    transfers: "拷贝、校验与任务记录，在一个地方掌握。",
                    recovery: "识别中断、离线目标和未完成校验，并安全恢复。",
                    projects: "提前整理拍摄计划，让每一次备份自动归位。",
                    library: "浏览备份文件清单，从已校验的副本继续工作。",
                    processing: "批量转码、进度、取消与失败重试。",
                    reports: "每一次传输都有据可查，每一份交付都有记录。",
                    storage: "识别已挂载的本地磁盘、素材卡和网络存储。",
                    diagnostics: "性能预检、恢复结论与脱敏诊断记录。",
                    maintenance: "长期复校验、项目模板、数据备份与工作站合并。",
                    help: "从第一次备份、历史项目接管到长期归档，逐步了解每个模块。",
                    settings: "为你的工作方式设定可靠的默认值。",
                  }[page]
                }
              </p>
            </div>
            {page === "overview" ? (
              <div className="date-stamp">
                <CalendarDays size={15} />
                {new Date().toLocaleDateString("zh-CN", {
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                })}
              </div>
            ) : page === "projects" ? (
              <Button kind="primary" onClick={() => setEditor({})}>
                <Plus size={16} />
                新建项目
              </Button>
            ) : page === "transfers" ? (
              <Button kind="primary" onClick={() => setComposer({})}>
                <Plus size={16} />
                新建备份
              </Button>
            ) : null}
          </div>
          {loading ? (
            <div className="loading">
              <LoaderCircle className="spin" />
              正在连接本地工作空间…
            </div>
          ) : (
            <>
              {page === "overview" && (
                <>
                  {tasks.length > 0 && (
                    <section className="operational-panel">
                      <div>
                        <span className="mini-label">
                          <span
                            className={
                              recoveryTasks.length > 0
                                ? "alert-dot"
                                : "live-dot"
                            }
                          />{" "}
                          DAILY OPERATIONS
                        </span>
                        <h2>
                          {current
                            ? `${current.name} · ${statusText[current.status]}`
                            : recoveryTasks.length > 0
                              ? `${recoveryTasks.length} 个任务需要处理`
                              : "当前无进行中的任务"}
                        </h2>
                        <p>
                          {current
                            ? `${current.currentFile || "正在准备"} · ${transferProgressLabel(current, current.status === "verifying" ? "verify" : "copy")}`
                            : `最近完成 ${finished.length} 次校验备份，连接下一张素材卡即可继续。`}
                        </p>
                      </div>
                      <div className="operational-actions">
                        {recoveryTasks.length > 0 && (
                          <Button
                            kind="danger"
                            onClick={() => {
                              go("recovery");
                            }}
                          >
                            <AlertTriangle size={15} />
                            查看异常
                          </Button>
                        )}
                        <Button kind="primary" onClick={() => setComposer({})}>
                          <Plus size={15} />
                          继续拷卡
                        </Button>
                      </div>
                    </section>
                  )}
                  {!tasks.length && (
                    <section className="welcome-panel">
                      <div className="welcome-copy">
                        <span className="mini-label">
                          <span className="live-dot" />
                          READY WHEN YOU ARE
                        </span>
                        <h2>
                          专注创作。
                          <br />
                          <span>备份，交给 Kocpy。</span>
                        </h2>
                        <p>
                          多目的地拷贝，逐文件哈希校验。
                          <br />
                          从第一张素材卡开始，建立可靠的工作流。
                        </p>
                        <Button kind="primary" onClick={() => setComposer({})}>
                          开始一次备份
                          <ArrowUpRight size={17} />
                        </Button>
                      </div>
                      <div className="flow-visual">
                        <div className="flow-top">
                          <span>YOUR FOOTAGE, PROTECTED.</span>
                          <ShieldCheck size={17} />
                        </div>
                        <div className="flow-diagram">
                          <div className="source-object">
                            <div className="sd-card">
                              <div className="sd-pins" />
                              <div className="sd-label">
                                K
                                <span>
                                  ORIGINAL
                                  <br />
                                  MEDIA
                                </span>
                              </div>
                              <div className="sd-bottom">
                                READ ONLY <i />
                              </div>
                            </div>
                            <span>素材源</span>
                          </div>
                          <div className="flow-route">
                            <div className="route-line" />
                            <span className="route-shield">
                              <ShieldCheck size={22} />
                            </span>
                            <small>HASH VERIFIED</small>
                          </div>
                          <div className="drive-stack">
                            <div className="drive-object">
                              <HardDrive size={25} />
                              <span>
                                PRIMARY
                                <i />
                              </span>
                            </div>
                            <div className="drive-object second">
                              <HardDrive size={25} />
                              <span>
                                BACKUP
                                <i />
                              </span>
                            </div>
                            <span>多重副本</span>
                          </div>
                        </div>
                        <div className="flow-footer">
                          <span>
                            <Check size={12} />
                            源文件保护
                          </span>
                          <span>
                            <Check size={12} />
                            独立校验
                          </span>
                          <span>
                            <Check size={12} />
                            可追溯报告
                          </span>
                        </div>
                      </div>
                    </section>
                  )}
                  <div className="stats-grid">
                    <Stat
                      icon={ArrowLeftRight}
                      label="进行中的任务"
                      value={String(running.length)}
                      hint={
                        current
                          ? statusText[current.status]
                          : "队列空闲，随时准备就绪"
                      }
                      accent
                    />
                    <Stat
                      icon={ShieldCheck}
                      label="已校验备份"
                      value={String(finished.length)}
                      hint="按完整内容证据统计，副本达标另行核对"
                    />
                    <Stat
                      icon={Layers}
                      label="已保护素材"
                      value={bytes(
                        finished.reduce((n, t) => n + t.totalBytes, 0),
                      )}
                      hint="按成功任务的源数据量统计"
                    />
                    <Stat
                      icon={FolderKanban}
                      label="进行中的项目"
                      value={String(
                        projects.filter((p) => p.status !== "archived").length,
                      )}
                      hint="有序管理每一个拍摄计划"
                    />
                  </div>
                  {activeProjectCloseouts.length > 0 && (
                    <section className="panel daily-closeout">
                      <div className="section-title">
                        <div>
                          <h2>
                            <ShieldCheck size={18} />
                            项目收工检查
                          </h2>
                          <span className="muted small">
                            按日期、设备和物理独立副本核对，不把同盘目录重复计数
                          </span>
                        </div>
                        <Button kind="subtle" onClick={() => go("projects")}>
                          查看项目
                          <ArrowRight size={14} />
                        </Button>
                      </div>
                      <div className="daily-closeout-list">
                        {activeProjectCloseouts.map(({ project, summary }) => (
                          <button
                            key={project.id}
                            onClick={() => {
                              setProjectDetailId(project.id);
                              go("projects");
                            }}
                          >
                            <FolderKanban size={18} />
                            <span className="closeout-project-copy">
                              <strong>{project.name}</strong>
                              <small>
                                {summary.pending.length
                                  ? `${summary.pending.length} 个单元明确需处理${summary.unconfirmed.length ? ` · ${summary.unconfirmed.length} 个待确认` : ""}`
                                  : summary.unconfirmed.length
                                    ? `${summary.unconfirmed.length} 个单元待确认是否使用`
                                    : "全部单元满足收工要求"}
                              </small>
                            </span>
                            <b
                              className={
                                summary.pending.length ||
                                summary.unconfirmed.length
                                  ? "amber-text"
                                  : "green-text"
                              }
                            >
                              {summary.complete} / {summary.total}
                              <small>单元达标</small>
                            </b>
                            <ChevronRight size={14} />
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                  <div className="overview-bottom">
                    <section className="panel">
                      <div className="section-title">
                        <h2>
                          最近传输 <span>{tasks.length}</span>
                        </h2>
                        <button
                          className="text-button"
                          onClick={() => go("transfers")}
                        >
                          查看全部
                          <ArrowRight size={14} />
                        </button>
                      </div>
                      {tasks.length ? (
                        taskRows(tasks.slice(0, 4), true)
                      ) : (
                        <Empty
                          icon={ArrowLeftRight}
                          title="你的第一份安心备份，从这里开始"
                          detail="连接素材卡或选择文件夹，Kocpy 会记录每一次传输。"
                          action={
                            <Button
                              kind="subtle"
                              onClick={() => setComposer({})}
                            >
                              <Plus size={14} />
                              新建备份任务
                            </Button>
                          }
                        />
                      )}
                    </section>
                    <section className="panel workflow-guide">
                      <div className="section-title">
                        <h2>简单三步，安心交付</h2>
                        <ShieldCheck size={17} />
                      </div>
                      {[
                        ["01", "选择素材源", "素材卡、拍摄目录，或多个来源。"],
                        ["02", "设置目的地", "最多 4 个副本，按项目自动归档。"],
                        ["03", "校验与交付", "回读哈希验证，导出备份报告。"],
                      ].map(([n, t, d]) => (
                        <div className="guide-step" key={n}>
                          <span>{n}</span>
                          <div>
                            <h3>{t}</h3>
                            <p>{d}</p>
                          </div>
                        </div>
                      ))}
                      <div className="guide-note">
                        <Info size={14} />
                        建议将副本保存到不同的物理磁盘。
                      </div>
                    </section>
                  </div>
                </>
              )}
              {page === "transfers" && (
                <section className="panel">
                  <div className="list-toolbar">
                    <div
                      className="tabs"
                      role="group"
                      aria-label="传输任务状态"
                    >
                      {[
                        ["all", "全部任务"],
                        ["active", "进行中"],
                        ["completed", "已完成"],
                        ["failed", "需处理"],
                        ["cancelled", "已取消"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          aria-pressed={filter === id}
                          className={filter === id ? "active" : ""}
                          onClick={() => setFilter(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <SearchBox
                      value={query}
                      onChange={setQuery}
                      placeholder="搜索任务或来源…"
                    />
                  </div>
                  {filtered.length ? (
                    <>
                      {taskRows(filtered.slice(0, taskLimit))}
                      {filtered.length > taskLimit && (
                        <Button
                          onClick={() => setTaskLimit((value) => value + 100)}
                        >
                          加载更多（已显示 {taskLimit}/{filtered.length}）
                        </Button>
                      )}
                    </>
                  ) : (
                    <Empty
                      icon={ArrowLeftRight}
                      title={tasks.length ? "没有匹配的任务" : "还没有传输任务"}
                      detail={
                        tasks.length
                          ? "试试其他关键词或筛选条件。"
                          : "备份过程和校验结果会实时显示在这里。"
                      }
                      action={
                        !tasks.length && (
                          <Button
                            kind="primary"
                            onClick={() => setComposer({})}
                          >
                            <Plus size={15} />
                            新建备份
                          </Button>
                        )
                      }
                    />
                  )}
                </section>
              )}
              {page === "recovery" && (
                <section className="panel recovery-center">
                  <div className="section-title">
                    <div>
                      <h2>
                        <RefreshCw size={18} />
                        恢复中心
                      </h2>
                      <span className="muted small">
                        集中处理异常退出、断点文件、离线目的地与未完成校验
                      </span>
                    </div>
                    <Button
                      kind="subtle"
                      onClick={() =>
                        void refresh().catch((error) =>
                          notify(readableOperationError(error), true),
                        )
                      }
                    >
                      <RefreshCw size={14} />
                      刷新记录（不读取磁盘校验）
                    </Button>
                  </div>
                  <div className="recovery-summary">
                    <div>
                      <strong>{recoveryTasks.length}</strong>
                      <span>需要关注的任务</span>
                    </div>
                    <div>
                      <strong>
                        {
                          recoveryTasks.filter((task) =>
                            task.destinations.some(
                              (destination) =>
                                destination.available === false ||
                                destination.error,
                            ),
                          ).length
                        }
                      </strong>
                      <span>失联或失败目标</span>
                    </div>
                    <div>
                      <strong>
                        {
                          recoveryTasks.filter(
                            (task) =>
                              task.transferredBytes > 0 &&
                              task.transferredBytes < task.totalBytes,
                          ).length
                        }
                      </strong>
                      <span>可恢复断点任务</span>
                    </div>
                  </div>
                  {recoveryTasks.length ? (
                    <div className="recovery-list">
                      {recoveryTasks.map((task) => {
                        const failedTargets = task.destinations.filter(
                            (destination) =>
                              destination.available === false ||
                              destination.error ||
                              !destination.verified,
                          ),
                          successfulTargets =
                            task.destinations.length - failedTargets.length;
                        const diagnosis =
                          task.status === "paused"
                            ? "任务仍在内存中暂停，可直接从当前位置继续"
                            : successfulTargets > 0 && failedTargets.length > 0
                              ? `${successfulTargets} 个目标已安全保留；只处理 ${failedTargets.length} 个失败目标`
                              : task.transferredBytes > 0
                                ? "将重新扫描素材源，验证并复用已有最终文件和安全断点"
                                : "任务尚未写入，可以重新加入队列";
                        return (
                          <div key={task.id}>
                            <span className="file-icon">
                              <RefreshCw size={18} />
                            </span>
                            <div>
                              <strong>{task.name}</strong>
                              <p>
                                {task.errorMessage
                                  ? recoveryAdvice(task.errorMessage).title
                                  : diagnosis}
                              </p>
                              <small>
                                {task.currentFile ||
                                  task.errorMessage ||
                                  task.sourcePath}
                              </small>
                            </div>
                            <div className="row">
                              <TaskBadge task={task} />
                              {task.provenance &&
                              task.provenance !== "kocpy-transfer" ? (
                                <Button
                                  kind="primary"
                                  onClick={() =>
                                    task.externalManifest
                                      ? setManifestIssue(task)
                                      : setExistingBaseline(task)
                                  }
                                >
                                  查看接管校验
                                </Button>
                              ) : task.status === "paused" ? (
                                <Button
                                  kind="primary"
                                  onClick={() =>
                                    void act(
                                      () => api.resumeTask(task.id),
                                      "任务已从当前检查点继续",
                                    )
                                  }
                                >
                                  <Play size={13} />
                                  从当前位置继续
                                </Button>
                              ) : (
                                <Button
                                  kind="primary"
                                  onClick={() => setRecoveryId(task.id)}
                                >
                                  <RefreshCw size={14} />
                                  检查并恢复
                                </Button>
                              )}
                              {task.totalFiles > 0 && (
                                <Button
                                  kind="subtle"
                                  onClick={() =>
                                    void act(
                                      () => api.reverifyTask(task.id),
                                      "复校验已完成",
                                    )
                                  }
                                >
                                  <ShieldCheck size={13} />
                                  重新校验全部副本
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <Empty
                      icon={CheckCheck}
                      title="没有需要恢复的任务"
                      detail="所有任务、目的地和校验记录均处于安全状态。"
                    />
                  )}
                </section>
              )}
              {page === "projects" && (
                <>
                  <div className="list-toolbar plain">
                    <div className="tabs" role="group" aria-label="项目状态">
                      {[
                        ["all", "进行中"],
                        ["archived", "已归档"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          aria-pressed={filter === id}
                          className={filter === id ? "active" : ""}
                          onClick={() => setFilter(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <SearchBox
                      value={query}
                      onChange={setQuery}
                      placeholder="搜索项目…"
                    />
                  </div>
                  <div className="projects-grid">
                    {projects
                      .filter(
                        (p) =>
                          (filter === "archived"
                            ? p.status === "archived"
                            : p.status !== "archived") &&
                          p.name.includes(query),
                      )
                      .map((p) => (
                        <section className="panel project-card" key={p.id}>
                          <div className="row between">
                            <span className="project-icon">
                              <FolderKanban size={24} />
                            </span>
                            <div className="row project-card-tools">
                              <Button
                                kind="icon"
                                title="检查项目目录结构"
                                onClick={() =>
                                  void act(async () => {
                                    const report =
                                      await api.inspectProjectStructure(p);
                                    const unavailable =
                                      report.destinations.filter(
                                        (item) => item.error,
                                      ).length;
                                    notify(
                                      report.missingCount ||
                                        report.conflictCount ||
                                        unavailable
                                        ? `目录需要处理：缺少 ${report.missingCount} 个，冲突 ${report.conflictCount} 个，离线 ${unavailable} 个`
                                        : `项目目录完整：${report.expectedCount} 个目录均已就绪`,
                                      Boolean(
                                        report.conflictCount || unavailable,
                                      ),
                                    );
                                  })
                                }
                              >
                                <ShieldCheck size={16} />
                              </Button>
                              <div
                                className="project-action-wrap"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <Button
                                  kind="icon"
                                  title="更多项目操作"
                                  data-project-menu-trigger={p.id}
                                  data-focus-id={`project-menu-${p.id}`}
                                  aria-haspopup="menu"
                                  aria-expanded={projectMenuId === p.id}
                                  onClick={() =>
                                    setProjectMenuId((current) =>
                                      current === p.id ? null : p.id,
                                    )
                                  }
                                >
                                  <MoreHorizontal size={17} />
                                </Button>
                                {projectMenuId === p.id && (
                                  <div
                                    className="project-action-menu"
                                    role="menu"
                                    aria-label={`${p.name} 项目操作`}
                                  >
                                    <button
                                      role="menuitem"
                                      onClick={() => {
                                        setProjectMenuId(null);
                                        setEditor(p);
                                      }}
                                    >
                                      <SlidersHorizontal size={14} />
                                      编辑项目
                                    </button>
                                    <button
                                      role="menuitem"
                                      onClick={() => {
                                        setProjectMenuId(null);
                                        void act(
                                          async () =>
                                            setProjects(
                                              await api.saveProject(
                                                {
                                                  ...p,
                                                  status:
                                                    p.status === "archived"
                                                      ? "active"
                                                      : "archived",
                                                },
                                                false,
                                              ),
                                            ),
                                          p.status === "archived"
                                            ? "项目已恢复到进行中"
                                            : "项目已归档",
                                        );
                                      }}
                                    >
                                      <Archive size={14} />
                                      {p.status === "archived"
                                        ? "恢复为进行中"
                                        : "归档项目"}
                                    </button>
                                    <button
                                      role="menuitem"
                                      className="danger"
                                      onClick={() =>
                                        void requestProjectDeletion(p)
                                      }
                                    >
                                      <Trash2 size={14} />
                                      删除项目记录
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <h2>{p.name}</h2>
                          <small className="mono muted">
                            {p.projectFolderName}
                          </small>
                          <p>
                            <CalendarDays size={13} />
                            {p.shootingDateStart || "未设置日期"}{" "}
                            {p.shootingDateEnd &&
                            p.shootingDateEnd !== p.shootingDateStart
                              ? "— " + p.shootingDateEnd
                              : ""}
                          </p>
                          <div className="chips">
                            {p.devices.map((d) => (
                              <span key={d}>{d}</span>
                            ))}
                          </div>
                          <div className="project-summary">
                            <span>
                              {p.destinationPaths?.length || 0} 个目的地
                            </span>
                            <span>
                              {
                                projectCoverage(
                                  p,
                                  tasks.filter((t) => t.projectId === p.id),
                                ).verified
                              }{" "}
                              卷内容校验通过
                            </span>
                          </div>
                          {(() => {
                            const related = tasks.filter(
                                (task) => task.projectId === p.id,
                              ),
                              coverage = projectCoverage(p, related),
                              { verified, compliant, attention, recorded } =
                                coverage,
                              received =
                                coverage.byProvenance["kocpy-transfer"] || 0,
                              imported = recorded - received;
                            return (
                              <div className="project-coverage">
                                <div className="coverage-heading">
                                  <strong>项目素材覆盖</strong>
                                  {p.expectedVolumes ? (
                                    <span>
                                      {Math.min(
                                        100,
                                        Math.round(
                                          (recorded / p.expectedVolumes) * 100,
                                        ),
                                      )}
                                      % 计划覆盖
                                    </span>
                                  ) : (
                                    <span>不推测未知历史总量</span>
                                  )}
                                </div>
                                <div className="coverage-metrics">
                                  <span>
                                    <b>{recorded}</b>已记录
                                  </span>
                                  <span>
                                    <b>{verified}</b>已验证
                                  </span>
                                  <span>
                                    <b>{compliant}</b>副本达标
                                  </span>
                                  <span
                                    className={
                                      attention ? "amber-text" : "green-text"
                                    }
                                  >
                                    <b>{attention}</b>需处理
                                  </span>
                                </div>
                                <small>
                                  Kocpy 接收 {received} · 外部接管 {imported}
                                  {p.managedSince
                                    ? ` · 自 ${p.managedSince} 起管理`
                                    : ""}
                                </small>
                              </div>
                            );
                          })()}
                          <div className="project-card-actions">
                            <Button
                              kind="primary"
                              onClick={() => setComposer({ project: p })}
                            >
                              <Plus size={16} />
                              <span>新建备份</span>
                            </Button>
                            <Button
                              kind="subtle"
                              onClick={() =>
                                setProjectDetailId(
                                  projectDetailId === p.id ? null : p.id,
                                )
                              }
                            >
                              <Activity size={16} />
                              <span>项目详情</span>
                            </Button>
                            <Button
                              kind="subtle"
                              onClick={() =>
                                void act(async () => {
                                  const root = await api.selectDirectory();
                                  if (!root) return;
                                  setExistingImport({
                                    project: p,
                                    preview: await api.previewExistingBackup(
                                      root,
                                      p.id,
                                    ),
                                  });
                                })
                              }
                            >
                              <FolderPlus size={16} />
                              <span>接管既有备份</span>
                            </Button>
                            <Button
                              kind="subtle"
                              onClick={() => {
                                setMaintenanceProjectId(p.id);
                                go("maintenance");
                              }}
                            >
                              <Layers size={16} />
                              <span>模板与交接</span>
                            </Button>
                          </div>
                        </section>
                      ))}
                  </div>
                  {projectDetail && (
                    <section className="panel project-insights">
                      <div className="section-title">
                        <div>
                          <h2>
                            <Activity size={18} />
                            {projectDetail.name} · 项目全周期
                          </h2>
                          <span className="muted small">
                            按拍摄日期与设备汇总素材卷、文件、容量和独立校验状态
                          </span>
                        </div>
                        <div className="row">
                          <Button
                            kind="subtle"
                            onClick={() =>
                              void act(async () => {
                                const result = await api.exportProjectReport(
                                  projectDetail.id,
                                  "csv",
                                );
                                if (result)
                                  notify(`项目 CSV 已保存：${result}`);
                              })
                            }
                          >
                            <Download size={14} />
                            CSV
                          </Button>
                          <Button
                            kind="subtle"
                            onClick={() =>
                              void act(async () => {
                                const result = await api.exportProjectReport(
                                  projectDetail.id,
                                  "json",
                                );
                                if (result)
                                  notify(`项目完整数据已保存：${result}`);
                              })
                            }
                          >
                            完整 JSON
                          </Button>
                          <Button
                            kind="subtle"
                            onClick={() =>
                              void act(async () => {
                                const result = await api.exportProjectReport(
                                  projectDetail.id,
                                  "pdf",
                                );
                                if (result)
                                  notify(`项目完整报告已保存：${result}`);
                              })
                            }
                          >
                            <FileCheck2 size={14} />
                            项目 PDF
                          </Button>
                          <Button
                            kind="primary"
                            onClick={() =>
                              void act(async () => {
                                const result = await api.exportProjectReport(
                                  projectDetail.id,
                                  "bundle",
                                );
                                if (result)
                                  notify(`项目归档包已创建：${result}`);
                              })
                            }
                          >
                            <Archive size={14} />
                            归档包
                          </Button>
                          <Button
                            kind="icon"
                            title="关闭项目详情"
                            onClick={() => setProjectDetailId(null)}
                          >
                            <X size={15} />
                          </Button>
                        </div>
                      </div>
                      <div className="project-total-cards">
                        <div>
                          <strong>{projectDetailLogicalVolumes.length}</strong>
                          <span>逻辑素材卷</span>
                        </div>
                        <div>
                          <strong>
                            {
                              projectDetailLogicalVolumes.filter(
                                (item) => item.compliant,
                              ).length
                            }{" "}
                            / {projectDetailLogicalVolumes.length}
                          </strong>
                          <span>达到副本要求</span>
                        </div>
                        <div>
                          <strong>
                            {projectDetailLogicalVolumes.reduce(
                              (sum, item) =>
                                sum + item.representative.totalFiles,
                              0,
                            )}
                          </strong>
                          <span>项目文件</span>
                        </div>
                        <div>
                          <strong>
                            {bytes(
                              projectDetailLogicalVolumes.reduce(
                                (sum, item) =>
                                  sum + item.representative.totalBytes,
                                0,
                              ),
                            )}
                          </strong>
                          <span>项目总素材</span>
                        </div>
                      </div>
                      <div className="closeout-note">
                        <ShieldCheck size={16} />
                        <span>
                          {projectDetailCloseout?.pending.length
                            ? `有 ${projectDetailCloseout.pending.length} 个日期/设备单元明确需要处理。`
                            : "当前没有明确缺失或校验异常。"}{" "}
                          {projectDetailCloseout?.unconfirmed.length
                            ? `另有 ${projectDetailCloseout.unconfirmed.length} 个单元当天未发现素材，等待确认是否使用。`
                            : "所有空白单元均已确认。"}{" "}
                          收工标准：每个使用中的设备至少有{" "}
                          {projectDetail.requiredCopies || 2}{" "}
                          份物理独立校验副本。没有文件夹不会自动等同于当天未使用。
                        </span>
                      </div>
                      <div className="daily-plan-operator">
                        <label>
                          每日计划操作人
                          <input
                            value={dailyPlanOperator}
                            onChange={(event) =>
                              setDailyPlanOperator(event.target.value)
                            }
                            placeholder="填写实际确认人后再标记设备状态"
                            aria-label="每日计划操作人"
                          />
                        </label>
                        <label>
                          临时设备所属拍摄日
                          <input
                            type="date"
                            value={dailyPlanDate}
                            min={projectDetailStart || undefined}
                            max={projectDetailEnd || undefined}
                            onChange={(event) =>
                              setDailyPlanDate(event.target.value)
                            }
                            aria-label="每日计划拍摄日期"
                          />
                        </label>
                        <span>
                          “应该有素材 / 当天未使用 /
                          休息日”都会追加操作人、时间和决定记录；不填写时保持未知。
                        </span>
                        <div className="daily-plan-temp">
                          <input
                            value={temporaryDailyDevice}
                            onChange={(event) =>
                              setTemporaryDailyDevice(event.target.value)
                            }
                            placeholder="临时设备，例如 Drone"
                            aria-label="临时设备"
                          />
                          <input
                            value={temporaryDailyPosition}
                            onChange={(event) =>
                              setTemporaryDailyPosition(event.target.value)
                            }
                            placeholder="机位（可选）"
                            aria-label="临时设备机位"
                          />
                          <Button
                            kind="subtle"
                            disabled={
                              !dailyPlanOperator.trim() ||
                              !temporaryDailyDevice.trim()
                            }
                            onClick={() =>
                              void updateProjectSchedule(
                                projectDetail,
                                dailyPlanDate,
                                temporaryDailyPosition.trim()
                                  ? temporaryDailyDevice.trim() +
                                      "::" +
                                      temporaryDailyPosition.trim()
                                  : temporaryDailyDevice.trim(),
                                "expected",
                              ).then((saved) => {
                                if (saved) {
                                  setTemporaryDailyDevice("");
                                  setTemporaryDailyPosition("");
                                }
                              })
                            }
                          >
                            <Plus size={13} />
                            加入当日临时设备
                          </Button>
                        </div>
                      </div>
                      <div className="project-evidence-strip">
                        <span>
                          当前规则版本{" "}
                          <b>
                            v
                            {projectDetail.ruleSnapshots?.find(
                              (item) =>
                                item.id === projectDetail.activeRuleSnapshotId,
                            )?.revision || "旧项目未建立"}
                          </b>
                        </span>
                        <span>
                          每日决定{" "}
                          <b>{projectDetail.dailyPlanDecisions?.length || 0}</b>{" "}
                          条
                        </span>
                        <span>
                          模板应用{" "}
                          <b>
                            {projectDetail.templateApplications?.length || 0}
                          </b>{" "}
                          次
                        </span>
                        <span>
                          历史规则素材卷{" "}
                          <b>
                            {
                              projectDetailLogicalVolumes.filter((volume) =>
                                volume.attempts.some(
                                  (task) =>
                                    task.projectRuleSnapshotId &&
                                    task.projectRuleSnapshotId !==
                                      projectDetail.activeRuleSnapshotId,
                                ),
                              ).length
                            }
                          </b>{" "}
                          个
                        </span>
                      </div>
                      <div className="project-matrix">
                        <div className="project-matrix-head">
                          <span>拍摄日期</span>
                          <span>设备 / 机位</span>
                          <span>素材卷</span>
                          <span>文件</span>
                          <span>素材量</span>
                          <span>收工检查</span>
                        </div>
                        {projectDates(
                          projectDetail,
                          projectDetailTasks,
                        ).flatMap((shootingDate) =>
                          projectDeviceCells(
                            projectDetail,
                            projectDetailTasks,
                            shootingDate,
                          ).map((deviceCell) => {
                            const cell = projectCellStatus(
                                projectDetail,
                                projectDetailTasks,
                                shootingDate,
                                deviceCell.device,
                                deviceCell.cameraPosition,
                              ),
                              rows = cell.rows;
                            return (
                              <div
                                className="project-matrix-row"
                                key={`${shootingDate}-${deviceCell.scheduleKey}`}
                              >
                                <strong>
                                  {shootingDate.replace(/-/g, "")}
                                </strong>
                                <span>{deviceCell.label}</span>
                                <span>{rows.length}</span>
                                <span>
                                  {rows.reduce(
                                    (sum, task) => sum + task.totalFiles,
                                    0,
                                  )}
                                </span>
                                <span>
                                  {bytes(
                                    rows.reduce(
                                      (sum, task) => sum + task.totalBytes,
                                      0,
                                    ),
                                  )}
                                </span>
                                {cell.unconfirmed ? (
                                  <span className="matrix-decisions">
                                    <button
                                      className="muted"
                                      onClick={() =>
                                        void updateProjectSchedule(
                                          projectDetail,
                                          shootingDate,
                                          deviceCell.scheduleKey,
                                          "unused",
                                        )
                                      }
                                    >
                                      确认未使用
                                    </button>
                                    <button
                                      className="amber-text"
                                      onClick={() =>
                                        void updateProjectSchedule(
                                          projectDetail,
                                          shootingDate,
                                          deviceCell.scheduleKey,
                                          "expected",
                                        )
                                      }
                                    >
                                      应该有素材
                                    </button>
                                  </span>
                                ) : (
                                  <button
                                    className={
                                      cell.exempt ||
                                      (rows.length && cell.safe === rows.length)
                                        ? "green-text"
                                        : "amber-text"
                                    }
                                    onClick={() =>
                                      !rows.length
                                        ? void updateProjectSchedule(
                                            projectDetail,
                                            shootingDate,
                                            deviceCell.scheduleKey,
                                            "clear",
                                          )
                                        : setDetail(
                                            (
                                              rows.find(
                                                (task) =>
                                                  !taskMeetsCopyRequirement(
                                                    task,
                                                    projectDetail.requiredCopies ||
                                                      2,
                                                  ),
                                              ) || rows[0]
                                            ).id,
                                          )
                                    }
                                    title={
                                      !rows.length ? "恢复为待确认" : cell.label
                                    }
                                  >
                                    {cell.label}
                                  </button>
                                )}
                              </div>
                            );
                          }),
                        )}
                      </div>
                      <div className="closeout-actions">
                        <span>整日未拍摄时可直接标记：</span>
                        {projectDates(projectDetail, projectDetailTasks).map(
                          (shootingDate) => (
                            <Button
                              key={shootingDate}
                              kind="subtle"
                              onClick={() =>
                                void updateProjectSchedule(
                                  projectDetail,
                                  shootingDate,
                                )
                              }
                            >
                              {projectDetail.restDays?.some(
                                (date) =>
                                  shootingDateKey(date) ===
                                  shootingDateKey(shootingDate),
                              ) ? (
                                <Check size={13} />
                              ) : (
                                <CalendarDays size={13} />
                              )}{" "}
                              {shootingDate.replace(/-/g, "")}{" "}
                              {projectDetail.restDays?.some(
                                (date) =>
                                  shootingDateKey(date) ===
                                  shootingDateKey(shootingDate),
                              )
                                ? "休息日"
                                : "标记休息"}
                            </Button>
                          ),
                        )}
                        <Button
                          kind="subtle"
                          onClick={() =>
                            void act(async () => {
                              const analysis =
                                await api.reanalyzeExistingProject(
                                  projectDetail.id,
                                  false,
                                );
                              setConfirm({
                                text: `检测到 ${analysis.importedTasks} 条接管记录；将修正 ${analysis.metadataUpdated} 条目录元数据、合并 ${analysis.duplicatesFound} 条重复素材卷记录，并移除 ${analysis.aggregateRecordsFound} 条误生成的日期/设备父级汇总记录。已读取 ${analysis.manifestsInspected} 份卡卷清单，其中 ${analysis.manifestDifferences} 份存在真实的路径或大小差异；另有 ${analysis.baselinesNeeded} 条记录仍需建立基线${analysis.unavailableSources ? `，${analysis.unavailableSources} 个来源当前离线，将保留原记录` : ""}。刷新只整理 Kocpy 记录并按清单元数据核对，不重新计算文件哈希、不移动或删除素材文件。`,
                                run: async () => {
                                  const result =
                                    await api.reanalyzeExistingProject(
                                      projectDetail.id,
                                      true,
                                    );
                                  await refresh();
                                  notify(
                                    `刷新完成：保留真实素材卷，移除 ${result.aggregateRecordsRemoved} 条父级汇总记录；${result.manifestDifferences} 份清单需要检查`,
                                  );
                                },
                              });
                            })
                          }
                        >
                          <ScanLine size={14} />
                          刷新接管信息
                        </Button>
                      </div>
                      {projectDetailTasks.length > 0 && (
                        <div className="project-task-breakdown">
                          <div className="project-task-breakdown-title">
                            <strong>素材卷明细</strong>
                            <span>
                              刷新后按唯一素材卷统计，不重复累加同一路径
                            </span>
                          </div>
                          <div className="project-task-breakdown-head">
                            <span>拍摄日期 · 设备 / 机位</span>
                            <span>素材卷</span>
                            <span>文件 · 素材量</span>
                            <span>接管可信状态</span>
                          </div>
                          {groupLogicalVolumes(
                            projectDetailTasks,
                            projectDetail.requiredCopies || 2,
                          )
                            .sort(
                              (a, b) =>
                                (
                                  a.representative.shootingDate || ""
                                ).localeCompare(
                                  b.representative.shootingDate || "",
                                ) ||
                                (a.representative.startedAt || 0) -
                                  (b.representative.startedAt || 0),
                            )
                            .map((logicalVolume) => {
                              const task = logicalVolume.representative;
                              return (
                                <div
                                  className="project-task-breakdown-row"
                                  key={logicalVolume.id}
                                >
                                  <span>
                                    {task.shootingDate?.replace(/-/g, "") ||
                                      "未标日期"}{" "}
                                    · {task.devices.join("/")}
                                    {task.cameraPosition
                                      ? ` · ${task.cameraPosition}`
                                      : ""}
                                  </span>
                                  <button
                                    className="project-roll-link"
                                    onClick={() => setDetail(task.id)}
                                    title="查看实时传输详情"
                                  >
                                    {task.name}
                                    {logicalVolume.attempts.length > 1 && (
                                      <small className="project-roll-attempts">
                                        {logicalVolume.attempts.length} 次尝试
                                      </small>
                                    )}
                                  </button>
                                  <small>
                                    {task.totalFiles} 个文件 ·{" "}
                                    {bytes(task.totalBytes)}
                                    {active(task) && (
                                      <span className="project-live-transfer">
                                        {task.status === "paused"
                                          ? "已暂停"
                                          : `${transferPhaseText(task)} · ${transferProgressLabel(task, task.status === "verifying" ? "verify" : "copy")} · ${transferTiming(task).speed ? `${bytes(transferTiming(task).speed)}/s` : "测速中"}`}
                                      </span>
                                    )}
                                  </small>
                                  <span className="task-state-actions">
                                    {(() => {
                                      const trust = taskTrustState(task);
                                      return task.externalManifest?.status ===
                                        "mismatch" ? (
                                        <button
                                          className={`badge manifest-badge ${trust.status}`}
                                          title="查看差异并处理"
                                          onClick={() => setManifestIssue(task)}
                                        >
                                          <i />
                                          {trust.label}
                                          <ChevronRight size={13} />
                                        </button>
                                      ) : task.externalManifest?.resolution
                                          ?.type === "revised-missing" ? (
                                        <button
                                          className={`badge manifest-badge ${trust.status}`}
                                          title="显示修订前的原始 MHL 审计副本"
                                          onClick={() =>
                                            void api.revealExistingManifestAudit(
                                              task.id,
                                            )
                                          }
                                        >
                                          <i />
                                          {trust.label}
                                          <FolderOpen size={13} />
                                        </button>
                                      ) : (
                                        <span
                                          className={`badge ${trust.status}`}
                                          title={task.errorMessage}
                                        >
                                          <i />
                                          {trust.label}
                                        </span>
                                      );
                                    })()}
                                    {task.provenance &&
                                      task.provenance !== "kocpy-transfer" &&
                                      task.status !== "completed" && (
                                        <button
                                          onClick={() =>
                                            setExistingBaseline(task)
                                          }
                                        >
                                          建立首次基线
                                        </button>
                                      )}
                                  </span>
                                </div>
                              );
                            })}
                        </div>
                      )}
                    </section>
                  )}
                  {!projects.filter((p) =>
                    filter === "archived"
                      ? p.status === "archived"
                      : p.status !== "archived",
                  ).length && (
                    <section className="panel">
                      <Empty
                        icon={FolderKanban}
                        title={
                          filter === "archived"
                            ? "还没有归档项目"
                            : "为下一次拍摄做好准备"
                        }
                        detail="保存项目名称、机位和备份目的地，减少现场重复设置。"
                        action={
                          filter !== "archived" && (
                            <Button
                              kind="primary"
                              onClick={() => setEditor({})}
                            >
                              <Plus size={15} />
                              创建拍摄项目
                            </Button>
                          )
                        }
                      />
                    </section>
                  )}
                </>
              )}
              {page === "storage" && (
                <>
                  <div className="row justify-end">
                    <Button
                      kind="subtle"
                      onClick={() =>
                        void act(async () => {
                          const preview = await api.ejectCompletedVolumes(true);
                          const eligible = preview.filter((item) => item.ok);
                          if (!eligible.length) {
                            notify(
                              preview
                                .map((item) => item.path + "：" + item.error)
                                .join("；") || "没有可推出的设备",
                              true,
                            );
                            return;
                          }
                          if (
                            !window.confirm(
                              "将安全推出以下设备（执行前再次检查）：\n" +
                                eligible.map((item) => item.path).join("\n") +
                                "\n以下设备保留：\n" +
                                preview
                                  .filter((item) => !item.ok)
                                  .map((item) => item.path + "：" + item.error)
                                  .join("\n"),
                            )
                          )
                            return;
                          const results = await api.ejectCompletedVolumes(
                            false,
                            eligible.map((item) => item.path),
                          );
                          const success = results.filter(
                            (result) => result.ok,
                          ).length;
                          setVolumes(await api.listVolumes());
                          notify(
                            `已推出 ${success} 个设备。${results.map((result) => result.path + "：" + (result.ok ? "已推出" : result.error)).join("；")}`,
                            results.some((result) => !result.ok),
                          );
                        })
                      }
                    >
                      <Eject size={14} />
                      安全推出所有已完成设备
                    </Button>
                  </div>
                  <div className="notice">
                    <Info size={16} />
                    <span>
                      网络存储请先在 Finder
                      中挂载。设备类型是自动判断的建议，你始终可以手动选择素材源和目的地。
                    </span>
                  </div>
                  <div className="volumes-grid">{volumes.map(volumeCard)}</div>
                  <section className="panel storage-note">
                    <ShieldCheck size={28} />
                    <div>
                      <h3>多一份副本，多一份安心</h3>
                      <p>
                        同一块硬盘的不同文件夹不构成独立冗余。建议至少保存两份副本，校验通过后再处理原始素材。
                      </p>
                    </div>
                  </section>
                </>
              )}
              {page === "reports" && (
                <>
                  <section className="panel activity-panel">
                    <div className="section-title">
                      <h2>备份活动</h2>
                      <span className="muted">最近 12 周 · 按完成日期统计</span>
                    </div>
                    <div className="activity-body">
                      <div>
                        <strong>
                          {
                            finished.filter(
                              (t) =>
                                (t.completedAt || 0) >
                                Date.now() - 84 * 86400000,
                            ).length
                          }
                        </strong>
                        <span>次校验完成</span>
                      </div>
                      <div className="heatmap">
                        {Array.from({ length: 84 }, (_, i) => {
                          const day = new Date();
                          day.setDate(day.getDate() - 83 + i);
                          const key = day.toLocaleDateString("sv-SE"),
                            count = finished.filter(
                              (t) =>
                                t.completedAt &&
                                new Date(t.completedAt).toLocaleDateString(
                                  "sv-SE",
                                ) === key,
                            ).length;
                          return (
                            <div
                              key={i}
                              className={count ? "filled" : ""}
                              title={`${key} · ${count} 次备份`}
                            />
                          );
                        })}
                      </div>
                      <div className="heatmap-legend">
                        每一个亮点
                        <br />
                        都是一份安心记录。
                        <span>
                          <i />
                          无备份
                          <i className="filled" />
                          已完成
                        </span>
                      </div>
                    </div>
                  </section>
                  <section className="panel">
                    <div className="section-title">
                      <h2>任务报告</h2>
                      <div className="row">
                        <input
                          aria-label="报告拍摄日期"
                          type="date"
                          value={reportDate}
                          onChange={(e) => setReportDate(e.target.value)}
                        />
                        <select
                          aria-label="报告项目范围"
                          value={reportProject}
                          onChange={(e) => setReportProject(e.target.value)}
                        >
                          <option value="">全部项目</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          kind="subtle"
                          onClick={() =>
                            void act(async () => {
                              const result = await api.exportResolveCsv(
                                reportDate,
                                reportProject || undefined,
                              );
                              if (result)
                                notify(`Resolve 媒体池清单已保存：${result}`);
                            })
                          }
                        >
                          <Clapperboard size={14} />
                          Resolve CSV
                        </Button>
                        <Button
                          kind="subtle"
                          onClick={() =>
                            void act(async () => {
                              const result = await api.exportDailyReport(
                                reportDate,
                                reportProject || undefined,
                              );
                              if (result) notify(`拍摄日汇总已保存：${result}`);
                            })
                          }
                        >
                          <CalendarDays size={14} />
                          导出所选日期汇总
                        </Button>
                        <SearchBox
                          value={query}
                          onChange={setQuery}
                          placeholder="搜索报告…"
                        />
                      </div>
                    </div>
                    {tasks.filter((t) => !active(t) && t.name.includes(query))
                      .length ? (
                      <div className="report-list">
                        {tasks
                          .filter((t) => !active(t) && t.name.includes(query))
                          .map((t) => (
                            <div className="report-row" key={t.id}>
                              <span className="file-icon">
                                <FileCheck2 size={21} />
                              </span>
                              <div className="task-name">
                                <strong>{t.name}</strong>
                                <span>
                                  {date(t.completedAt)} · {t.totalFiles} 个文件
                                  · {bytes(t.totalBytes)}
                                </span>
                              </div>
                              <TaskBadge task={t} />
                              <Button
                                kind="subtle"
                                onClick={() => void exportReport(t.id, "pdf")}
                              >
                                <Download size={14} />
                                PDF 报告
                              </Button>
                              <Button
                                kind="icon"
                                title="导出 MHL 素材哈希清单"
                                onClick={() => void exportReport(t.id, "mhl")}
                              >
                                <File size={16} />
                              </Button>
                              <Button
                                kind="icon"
                                title="导出通过 ASC XSD 结构验证的 ASC MHL v2 清单"
                                onClick={() =>
                                  void exportReport(t.id, "ascmhl")
                                }
                              >
                                <ShieldCheck size={16} />
                              </Button>
                            </div>
                          ))}
                      </div>
                    ) : (
                      <Empty
                        icon={FileCheck2}
                        title="让每次交付都有据可查"
                        detail="任务结束后，这里会生成可导出的 PDF 报告、JSON 记录与 MHL 哈希清单。"
                      />
                    )}
                  </section>
                </>
              )}
              {page === "library" && (
                <Library
                  tasks={tasks}
                  query={query}
                  setQuery={setQuery}
                  reveal={(p) => void act(() => api.reveal(p))}
                  proxy={setProxy}
                />
              )}
              {page === "processing" && (
                <ProxyQueue
                  jobs={proxyJobs}
                  act={act}
                  refresh={async () => setProxyJobs(await api.getProxyJobs())}
                />
              )}
              {page === "diagnostics" && (
                <DiagnosticsPage
                  tasks={tasks}
                  volumes={volumes}
                  notify={notify}
                />
              )}
              {page === "maintenance" && (
                <MaintenancePage
                  initialProjectId={maintenanceProjectId}
                  tasks={tasks}
                  projects={projects}
                  refreshProjects={refresh}
                  notify={notify}
                />
              )}
              {page === "help" && (
                <HelpPage go={go} openBackup={() => setComposer({})} />
              )}
              {page === "settings" && (
                <SettingsPage
                  settings={settings}
                  onSave={async (s) => {
                    await api.saveSettings(s);
                    setSettings(s);
                    notify("偏好设置已保存");
                  }}
                  notify={notify}
                  updateInfo={updateInfo}
                  setUpdateInfo={setUpdateInfo}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              Kocpy <i>STUDIO</i>
            </span>
            <span>
              <ShieldCheck size={12} />
              只读素材源 · 逐文件校验 · 本地记录
            </span>
          </footer>
        </main>
        {current && (
          <button className="running-bar" onClick={() => setDetail(current.id)}>
            <LoaderCircle size={15} className="spin" />
            <strong>{current.name}</strong>
            <span>{statusText[current.status]}</span>
            <div className="mini-progress">
              <i
                className="copy-fill"
                style={{
                  width: `${current.copyProgress || 0}%`,
                }}
              />
              <i
                className="verify-fill"
                style={{ width: `${current.verifyProgress || 0}%` }}
              />
            </div>
            <span>
              {current.status === "verifying" ? "校验" : "拷贝"}{" "}
              {transferProgressLabel(
                current,
                current.status === "verifying" ? "verify" : "copy",
              )}
            </span>
            <ChevronRight size={15} />
          </button>
        )}
        {existingImport && (
          <ExistingImportModal
            value={existingImport}
            onClose={() => setExistingImport(null)}
            onImported={async () => {
              setExistingImport(null);
              await refresh();
              setProjects(await api.getProjects());
              notify("既有备份已接管到项目；可信度已明确记录");
            }}
          />
        )}
        {existingBaseline && (
          <ExistingBaselineModal
            task={existingBaseline}
            onClose={() => setExistingBaseline(null)}
            onCompleted={async () => {
              setExistingBaseline(null);
              await refresh();
              notify("现存副本已完成读取并建立首次哈希基线");
            }}
          />
        )}
        {manifestIssue && (
          <ManifestIssueModal
            task={manifestIssue}
            onClose={() => setManifestIssue(null)}
            onCompleted={async (message) => {
              setManifestIssue(null);
              await refresh();
              notify(message);
            }}
            onUpdated={async (message) => {
              await refresh();
              notify(message);
            }}
          />
        )}
      </div>
      {recoveryId && tasks.find((t) => t.id === recoveryId) && (
        <RecoveryDialog
          key={recoveryId}
          task={tasks.find((t) => t.id === recoveryId)!}
          onClose={() => setRecoveryId(null)}
          onRecovered={async () => {
            await refresh();
            notify("未通过目标已加入安全重试队列；请关注后续复制与校验结果。");
          }}
          onNewTask={(source) => {
            const task = tasks.find((t) => t.id === recoveryId);
            setRecoveryId(null);
            setDetail(null);
            setComposer({
              source,
              project: projects.find((p) => p.id === task?.projectId),
            });
          }}
          onExternal={() => {
            const task = tasks.find((t) => t.id === recoveryId)!;
            setRecoveryId(null);
            setDetail(null);
            task.externalManifest
              ? setManifestIssue(task)
              : setExistingBaseline(task);
          }}
        />
      )}
      {composer && (
        <Composer
          initial={composer}
          volumes={volumes}
          projects={projects}
          settings={settings}
          onClose={() => setComposer(null)}
          onCreated={async () => {
            await refresh();
            setProjects(await api.getProjects());
            setComposer(null);
            go("transfers");
            notify("任务已加入传输队列");
          }}
          onCreateProject={() => setEditor({})}
        />
      )}
      {editor && (
        <ProjectEditor
          initial={editor}
          onClose={() => setEditor(null)}
          onSave={saveProject}
        />
      )}
      {selected && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDetail(null);
          }}
        >
          <section
            className="detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="任务详情"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow">TRANSFER DETAIL</span>
                <h2>{selected.name}</h2>
              </div>
              <Button
                kind="icon"
                title="关闭任务详情"
                onClick={() => setDetail(null)}
              >
                <X size={20} />
              </Button>
            </div>
            <div className="detail-body">
              <div className="row between">
                <TaskBadge task={selected} />
                <span className="mono muted">
                  {selected.hashAlgorithm.toUpperCase()}
                </span>
              </div>
              <div className="detail-stats">
                <div>
                  <strong>{bytes(selected.totalBytes)}</strong>
                  <span>素材大小</span>
                </div>
                <div>
                  <strong>
                    {selected.completedFiles} / {selected.totalFiles}
                  </strong>
                  <span>已处理文件</span>
                </div>
                <div>
                  <strong>
                    {transferTiming(selected).speed
                      ? bytes(transferTiming(selected).speed) + "/s"
                      : "—"}
                  </strong>
                  <span>
                    {selected.status === "verifying"
                      ? "校验回读速度"
                      : "实时传输速度"}
                  </span>
                </div>
                <div>
                  <strong>
                    {transferTiming(selected).seconds > 0
                      ? duration(transferTiming(selected).seconds)
                      : "—"}
                  </strong>
                  <span>{transferTiming(selected).label}</span>
                </div>
              </div>
              <div className="phase-head">
                <span>复制 {transferProgressLabel(selected, "copy")}</span>
                <span>校验 {transferProgressLabel(selected, "verify")}</span>
              </div>
              {active(selected) && (
                <p className="muted small" role="status">
                  {transferPhaseText(selected)}
                </p>
              )}
              <div className="progress-track layered-progress">
                <i
                  className="copy-fill"
                  style={{ width: `${selected.copyProgress || 0}%` }}
                />
                <i
                  className="verify-fill"
                  style={{ width: `${selected.verifyProgress || 0}%` }}
                />
              </div>
              <p className="current-file mono">
                {selected.currentFile ||
                  (active(selected)
                    ? transferPhaseText(selected)
                    : taskTrustState(selected).contentVerified
                      ? taskTrustState(selected).label
                      : "等待或任务已停止")}
              </p>
              {!active(selected) && (
                <div className="trust-evidence" role="status">
                  <strong>{taskTrustState(selected).label}</strong>
                  <p>{taskTrustState(selected).explanation}</p>
                  <p>{taskTrustState(selected).nextStep}</p>
                  <small>
                    依据：{taskTrustState(selected).basis} · 最近记录：
                    {taskTrustState(selected).verifiedAt
                      ? new Date(
                          taskTrustState(selected).verifiedAt!,
                        ).toLocaleString()
                      : "未记录完整校验时间"}
                  </small>
                </div>
              )}
              {taskTrustState(selected).contentVerified && (
                <div className="completion-conclusion">
                  <CheckCircle2 size={17} />
                  <div>
                    <strong>
                      {selected.destinations.filter((d) => d.verified).length}{" "}
                      个目标通过校验 · {verifiedPhysicalCopyCount(selected)}{" "}
                      份可计数副本
                    </strong>
                    <span>
                      {copyEvidenceSummary(selected.destinations)
                        .independencePending
                        ? "物理独立性证据不足，未将不同卷 UUID 自动计作多份独立副本。重新校验可更新在线副本的存储关系；旧校验记录仍保留。"
                        : "副本计数按已记录的系统存储关系保守判定；校验完成不等于可以格式化原卡。"}
                    </span>
                  </div>
                </div>
              )}
              {selected.status === "completed" &&
                !!selected.completionActionRecords?.length && (
                  <section
                    className="completion-actions"
                    aria-label="完成动作建议"
                  >
                    <div className="completion-actions-heading">
                      <div>
                        <strong>完成动作建议</strong>
                        <p>
                          仅在你确认后执行；失败或重复触发不会改变备份与校验结论，也不会修改
                          MHL。
                        </p>
                      </div>
                      <label>
                        本次操作人
                        <input
                          value={completionOperator}
                          placeholder="填写实际操作人"
                          maxLength={120}
                          onChange={(event) =>
                            setCompletionOperator(event.target.value)
                          }
                        />
                      </label>
                    </div>
                    <div className="completion-action-list">
                      {selected.completionActionRecords.map((record) => (
                        <div
                          className={`completion-action ${record.status}`}
                          key={record.key}
                        >
                          <div>
                            <strong>
                              {completionActionLabels[record.action]}
                            </strong>
                            <span>{completionActionStatus[record.status]}</span>
                            <small>
                              规则依据：
                              {record.ruleSnapshotId
                                ? `${record.ruleSnapshotId.slice(0, 12)}…`
                                : "旧项目规则"}
                              {record.attempts.length
                                ? ` · ${record.attempts.length} 次授权记录`
                                : " · 尚未授权"}
                            </small>
                            {record.result && <p>{record.result}</p>}
                            {record.error && (
                              <p className="red-text">
                                {record.error}
                                。请先核对现有产物或设备状态，再显式重试。
                              </p>
                            )}
                          </div>
                          <div className="completion-action-buttons">
                            {record.outputPaths?.map((output) => (
                              <Button
                                kind="icon"
                                title="在 Finder 中显示产物"
                                key={output}
                                onClick={() =>
                                  void act(() => api.reveal(output))
                                }
                              >
                                <FolderOpen size={15} />
                              </Button>
                            ))}
                            {!["completed", "skipped"].includes(
                              record.status,
                            ) && (
                              <>
                                <Button
                                  kind="subtle"
                                  disabled={
                                    record.status === "running" ||
                                    !completionOperator.trim()
                                  }
                                  onClick={() =>
                                    void act(async () => {
                                      try {
                                        return await api.runCompletionAction(
                                          selected.id,
                                          record.action,
                                          completionOperator,
                                        );
                                      } finally {
                                        const latest = await api
                                          .getTask(selected.id)
                                          .catch(() => null);
                                        if (latest) setDetailTask(latest);
                                        await refresh().catch(() => undefined);
                                      }
                                    }, `${completionActionLabels[record.action]}完成`)
                                  }
                                >
                                  {record.status === "running" ? (
                                    <LoaderCircle size={14} className="spin" />
                                  ) : (
                                    <Play size={14} />
                                  )}
                                  {record.status === "failed"
                                    ? "重新执行"
                                    : "确认执行"}
                                </Button>
                                <Button
                                  kind="subtle"
                                  disabled={
                                    record.status === "running" ||
                                    !completionOperator.trim()
                                  }
                                  onClick={() =>
                                    void act(async () => {
                                      try {
                                        return await api.skipCompletionAction(
                                          selected.id,
                                          record.action,
                                          completionOperator,
                                        );
                                      } finally {
                                        const latest = await api
                                          .getTask(selected.id)
                                          .catch(() => null);
                                        if (latest) setDetailTask(latest);
                                        await refresh().catch(() => undefined);
                                      }
                                    })
                                  }
                                >
                                  本任务跳过
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              {selected.errorMessage && (
                <div className="error-box task-recovery-callout" role="alert">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>
                      {recoveryAdvice(selected.errorMessage).title}
                    </strong>
                    <p>{selected.errorMessage}</p>
                    <small>
                      保留已有副本与断点。先检查连接和原因，不跳过校验。
                    </small>
                  </div>
                  <Button
                    kind="subtle"
                    onClick={() => {
                      setRecoveryId(selected.id);
                      setDetail(null);
                    }}
                  >
                    检查并恢复
                  </Button>
                </div>
              )}
              <h3 className="detail-label">素材来源</h3>
              <button
                className="detail-path"
                onClick={() => void act(() => api.reveal(selected.sourcePath))}
              >
                <MemoryStick size={19} />
                <span>{selected.sourcePath}</span>
                <ExternalLink size={14} />
              </button>
              {!!selected.existingAuditTrail?.length && (
                <details className="context-help existing-audit-trail">
                  <summary>
                    接管与维护审计（{selected.existingAuditTrail.length}）
                  </summary>
                  <p>
                    记录接管、首次基线、清单处理、刷新与重定位；旧路径和旧结论不会因后续操作被覆盖。
                  </p>
                  <div className="audit-event-list">
                    {selected.existingAuditTrail
                      .slice()
                      .reverse()
                      .map((event) => (
                        <div key={event.id}>
                          <strong>{event.summary}</strong>
                          <span>
                            {new Date(event.at).toLocaleString()} ·{" "}
                            {event.operator}
                          </span>
                          <small className="mono">
                            {event.previousPath
                              ? `${event.previousPath} → ${event.sourcePath}`
                              : event.sourcePath}
                          </small>
                          {event.digest && (
                            <small className="mono">
                              证据摘要 {event.digest.slice(0, 16)}…
                            </small>
                          )}
                        </div>
                      ))}
                  </div>
                </details>
              )}
              {selected.mediaBreakdown && (
                <div className="media-breakdown">
                  {(["video", "photo", "audio", "other"] as const).map(
                    (kind) => (
                      <div key={kind}>
                        <strong>
                          {selected.mediaBreakdown![kind].files} 个文件
                        </strong>
                        <span>
                          {
                            {
                              video: "视频",
                              photo: "照片 / RAW",
                              audio: "音频",
                              other: "其他",
                            }[kind]
                          }{" "}
                          · {bytes(selected.mediaBreakdown![kind].bytes)}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              )}
              {(selected.sourceHashHistory?.length ||
                selected.sourceCopyReadHistory?.length ||
                selected.performanceSummary) && (
                <div className="source-performance-grid">
                  <div className="performance-card">
                    <div>
                      <strong>源素材哈希读取</strong>
                      <span>
                        {performanceText(selected.sourceHashPerformance)}
                      </span>
                    </div>
                    <SpeedSparkline
                      values={(selected.sourceHashHistory || [])
                        .slice(-30)
                        .map((point) => point.speed)}
                    />
                  </div>
                  <div className="performance-card">
                    <div>
                      <strong>源素材分发读取</strong>
                      <span>
                        {performanceText(selected.sourceCopyReadPerformance)}
                      </span>
                    </div>
                    <SpeedSparkline
                      values={(selected.sourceCopyReadHistory || [])
                        .slice(-30)
                        .map((point) => point.speed)}
                      color="var(--amber)"
                    />
                  </div>
                  {!active(selected) && <p>{selected.performanceSummary}</p>}
                </div>
              )}
              <h3 className="detail-label">备份目的地</h3>
              {selected.destinations.map((d) => (
                <div className="destination-detail" key={d.id}>
                  <div className="row">
                    <HardDrive size={20} />
                    <div>
                      <strong>{d.label}</strong>
                      <p className="mono">{d.resolvedPath || d.path}</p>
                    </div>
                    <Button
                      kind="icon"
                      title="在 Finder 中显示目的地"
                      onClick={() =>
                        void act(() => api.reveal(d.resolvedPath || d.path))
                      }
                    >
                      <FolderOpen size={16} />
                    </Button>
                    {selected.status === "completed" &&
                      d.path.startsWith("/Volumes/") && (
                        <Button
                          kind="icon"
                          title="安全推出此磁盘"
                          onClick={() =>
                            void act(
                              () =>
                                api.ejectVolume(
                                  `/Volumes/${d.path.split("/")[2]}`,
                                ),
                              "设备已安全推出",
                            )
                          }
                        >
                          <Eject size={15} />
                        </Button>
                      )}
                  </div>
                  <div className="destination-status">
                    <span>
                      复制 {transferProgressLabel(d, "copy")} · 校验{" "}
                      {transferProgressLabel(d, "verify")} ·{" "}
                      {(
                        selected.status === "verifying"
                          ? d.verifySpeedBps
                          : selected.status === "running"
                            ? d.speedBps
                            : 0
                      )
                        ? `${bytes(selected.status === "verifying" ? d.verifySpeedBps : d.speedBps)}/s`
                        : `已保存 ${bytes(savedDestinationBytes(selected, d))} · 本次写入 ${bytes(d.bytesWritten)}`}
                    </span>
                    <span
                      className={
                        d.verified
                          ? "green-text"
                          : d.error
                            ? "red-text"
                            : "muted"
                      }
                    >
                      {d.verified ? "✓ 哈希一致" : d.error || "尚未完成校验"}
                    </span>
                  </div>
                  {d.speedHistory?.length ? (
                    <div className="destination-chart">
                      <SpeedSparkline
                        values={d.speedHistory.map((point) =>
                          selected.status === "verifying"
                            ? point.verify
                            : point.copy,
                        )}
                        color={
                          selected.status === "verifying"
                            ? "var(--green)"
                            : "var(--purple)"
                        }
                      />
                      <small>
                        最近 30 秒 ·{" "}
                        {selected.status === "verifying" ? "回读" : "写入"}
                      </small>
                    </div>
                  ) : null}
                  {(d.performance || d.verifyPerformance) && (
                    <div className="performance-summary">
                      <small>写入：{performanceText(d.performance)}</small>
                      <small>
                        回读：{performanceText(d.verifyPerformance)}
                      </small>
                    </div>
                  )}
                </div>
              ))}
              <details className="log-box">
                <summary>
                  校验日志 <span>{selected.verifyLog.length} 条最近记录</span>
                </summary>
                <pre>
                  {selected.verifyLog.join("\n") ||
                    "任务启动后会在此记录校验结果。"}
                </pre>
              </details>
            </div>
            <div className="modal-footer">
              <span className="muted small">
                {date(selected.startedAt || selected.createdAt)}
              </span>
              <div className="row">
                {active(selected) ? (
                  <>
                    {selected.status === "paused" ? (
                      <Button
                        kind="subtle"
                        disabled={taskCommand?.id === selected.id}
                        onClick={() => void controlTask(selected.id, "resume")}
                      >
                        <Play size={14} />
                        {taskCommand?.id === selected.id
                          ? taskCommand.action === "pause"
                            ? "正在暂停…"
                            : "正在继续…"
                          : "继续"}
                      </Button>
                    ) : ["running", "verifying"].includes(selected.status) ? (
                      <Button
                        kind="subtle"
                        disabled={taskCommand?.id === selected.id}
                        onClick={() => void controlTask(selected.id, "pause")}
                      >
                        <Pause size={14} />
                        {taskCommand?.id === selected.id
                          ? taskCommand.action === "pause"
                            ? "正在暂停…"
                            : "正在继续…"
                          : "暂停"}
                      </Button>
                    ) : null}
                    <Button
                      kind="subtle"
                      onClick={() =>
                        void act(async () => {
                          await api.setPriority(
                            selected.id,
                            !selected.priority,
                          );
                          await refresh();
                        })
                      }
                    >
                      <ChevronsUp size={15} />
                      {selected.priority ? "取消优先" : "优先执行"}
                    </Button>
                    <Button
                      kind="danger"
                      onClick={() =>
                        void act(() => api.cancelTask(selected.id))
                      }
                    >
                      <Square size={13} />
                      取消任务
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      kind="icon"
                      title="删除任务记录（保留素材文件）"
                      onClick={() =>
                        setConfirm({
                          text: "删除这条任务记录？只删除记录，不会删除任何素材或备份文件。",
                          run: async () => {
                            await api.deleteTask(selected.id);
                            await refresh();
                            setDetail(null);
                          },
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </Button>
                    {selected.status !== "completed" && (
                      <Button
                        kind="subtle"
                        onClick={() => {
                          setRecoveryId(selected.id);
                          setDetail(null);
                        }}
                      >
                        <RefreshCw size={14} />
                        检查并恢复
                      </Button>
                    )}
                    {selected.fileRecords.length > 0 && (
                      <Button
                        kind="subtle"
                        onClick={() =>
                          void act(
                            () => api.reverifyTask(selected.id),
                            "重新校验完成",
                          )
                        }
                      >
                        <ShieldCheck size={14} />
                        重新校验
                      </Button>
                    )}
                    <Button
                      kind="primary"
                      onClick={() => void exportReport(selected.id, "pdf")}
                    >
                      <Download size={15} />
                      导出报告
                    </Button>
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
      {proxy && (
        <ProxyDialog
          file={proxy}
          busy={proxyBusy}
          setBusy={setProxyBusy}
          onClose={() => setProxy(null)}
          notify={notify}
        />
      )}
      {confirm && (
        <div className="modal-backdrop top-layer">
          <section
            className="confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-description"
            data-return-focus-id={confirm.returnFocusId}
          >
            <AlertTriangle size={27} />
            <h2 id="confirm-dialog-title">请确认此操作</h2>
            <p id="confirm-dialog-description">{confirm.text}</p>
            {confirm.acknowledgement && (
              <label className="confirm-acknowledgement">
                <input
                  type="checkbox"
                  checked={confirmAcknowledged}
                  onChange={(event) =>
                    setConfirmAcknowledged(event.target.checked)
                  }
                />
                <span>{confirm.acknowledgement}</span>
              </label>
            )}
            {confirm.requiredText && (
              <label className="confirm-required-text">
                输入项目名称“{confirm.requiredText}”继续
                <input
                  autoFocus
                  value={confirmInput}
                  onChange={(event) => setConfirmInput(event.target.value)}
                  placeholder={confirm.requiredText}
                />
              </label>
            )}
            <div className="row">
              <Button onClick={() => setConfirm(null)}>取消</Button>
              <Button
                kind={confirm.danger ? "danger" : "primary"}
                disabled={Boolean(
                  (confirm.requiredText &&
                    confirmInput !== confirm.requiredText) ||
                  (confirm.acknowledgement && !confirmAcknowledged),
                )}
                onClick={() => {
                  const action = confirm.run;
                  setConfirm(null);
                  void act(action);
                }}
              >
                {confirm.actionLabel || "确认"}
              </Button>
            </div>
          </section>
        </div>
      )}
      {completion && (
        <div className="completion-banner" role="status">
          <span>备份与校验完成：{completion.name}</span>
          <Button
            onClick={() => {
              setDetail(completion.id);
              setCompletion(null);
            }}
          >
            查看详情
          </Button>
          <Button onClick={() => setCompletion(null)}>关闭</Button>
        </div>
      )}
      {toast && (
        <div
          role={toast.error ? "alert" : "status"}
          className={`toast ${toast.error ? "error" : ""}`}
        >
          {toast.error ? (
            <AlertTriangle size={17} />
          ) : (
            <CheckCircle2 size={17} />
          )}
          <span>{toast.message}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function Stat({
  icon: Icon,
  label,
  value,
  hint,
  accent = false,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat-card ${accent ? "accent" : ""}`}>
      <div className="row between">
        <span>{label}</span>
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search">
      <Search size={15} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value ? (
        <button title="清空搜索" onClick={() => onChange("")}>
          <X size={13} />
        </button>
      ) : (
        <kbd>/</kbd>
      )}
    </label>
  );
}
function Library({
  tasks,
  query,
  setQuery,
  reveal,
  proxy,
}: {
  tasks: BackupTask[];
  query: string;
  setQuery: (s: string) => void;
  reveal: (p: string) => void;
  proxy: (f: { path: string; name: string; paths?: string[] }) => void;
}) {
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [catalogBusy, setCatalogBusy] = useState(true),
    [catalogError, setCatalogError] = useState("");
  useEffect(
    () =>
      api.onWorkspaceChanged(() => setCatalogRevision((value) => value + 1)),
    [],
  );
  const taskSignature = tasks
    .map((task) => task.id + ":" + task.status + ":" + task.completedAt)
    .join("|");
  const [kind, setKind] = useState("all"),
    [pagination, setPagination] = useState<{
      key: string;
      index: number;
      cursors: Array<string | undefined>;
    }>({ key: "", index: 0, cursors: [undefined] }),
    [selectedPaths, setSelectedPaths] = useState<string[]>([]),
    [locations, setLocations] = useState<Record<string, string>>({}),
    [files, setFiles] = useState<any[]>([]),
    [nextCursor, setNextCursor] = useState<string | undefined>(),
    [preview, setPreview] = useState<any>(null),
    [previewBusy, setPreviewBusy] = useState(false);
  const pageKey = [query, kind, taskSignature, catalogRevision].join("\0"),
    pageIndex = pagination.key === pageKey ? pagination.index : 0,
    pageCursor =
      pagination.key === pageKey
        ? pagination.cursors[pagination.index]
        : undefined;
  useEffect(() => {
    let stopped = false;
    setCatalogBusy(true);
    setCatalogError("");
    setNextCursor(undefined);
    const timer = setTimeout(
      () =>
        void api
          .getCatalogFiles({
            query,
            kind,
            limit: 100,
            cursor: pageCursor,
          })
          .then((page) => {
            if (!stopped) {
              setNextCursor(page.nextCursor);
              setFiles(
                page.rows.map((row: any) => ({
                  ...row,
                  task: row.task_name,
                  taskId: row.task_id,
                  id: `${row.task_id}${row.relativePath}`,
                })),
              );
            }
          })
          .catch((error) => {
            if (!stopped) setCatalogError(readableOperationError(error));
          })
          .finally(() => {
            if (!stopped) setCatalogBusy(false);
          }),
      200,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [query, kind, pageCursor, pageKey]);
  useEffect(() => {
    setSelectedPaths([]);
  }, [query, kind, catalogRevision]);
  const reportError = (error: unknown) =>
    setCatalogError(readableOperationError(error));
  const isVideo = (name: string) => /\.(mov|mp4|mxf|mkv|avi|m4v)$/i.test(name);
  const isColor = (name: string) => /\.(cube|cdl|cc|ccc|clf)$/i.test(name);
  const filtered = files;
  return (
    <section className="panel">
      <div className="list-toolbar">
        <div className="tabs" role="group" aria-label="素材类型">
          {[
            ["all", "全部文件"],
            ["video", "视频"],
            ["image", "照片 / RAW"],
            ["audio", "音频"],
            ["color", "LUT / CDL"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={kind === id}
              className={kind === id ? "active" : ""}
              onClick={() => {
                setKind(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="row">
          <Button onClick={() => setCatalogRevision((value) => value + 1)}>
            刷新可访问副本
          </Button>
          {selectedPaths.length > 0 && (
            <Button onClick={() => setSelectedPaths([])}>清除选择</Button>
          )}
          {selectedPaths.length > 0 && (
            <Button
              kind="primary"
              onClick={() =>
                proxy({
                  name: `${selectedPaths.length} 个视频`,
                  path: selectedPaths[0],
                  paths: selectedPaths,
                })
              }
            >
              <Activity size={14} />
              批量代理 {selectedPaths.length}
            </Button>
          )}
          <SearchBox
            value={query}
            onChange={(v) => {
              setQuery(v);
            }}
            placeholder="搜索素材文件…"
          />
        </div>
      </div>
      {catalogError && (
        <div className="error-box" role="alert">
          {catalogError}
          <Button onClick={() => setCatalogRevision((value) => value + 1)}>
            重试加载
          </Button>
        </div>
      )}
      {catalogBusy && <p role="status">正在加载素材与可访问副本…</p>}
      {filtered.length ? (
        <>
          <div className="library-head">
            <span>文件名称 / 所属任务</span>
            <span>大小</span>
            <span>副本状态</span>
            <span>操作</span>
          </div>
          {filtered.map((f) => {
            const verified = f.destinations.filter((d: any) => d.verified),
              p =
                locations[f.id] ||
                verified.find((copy: any) => copy.online)?.path;
            return (
              <div className="library-row" key={f.id}>
                <div className="row">
                  {isVideo(f.name) && p && (
                    <input
                      type="checkbox"
                      aria-label={`选择 ${f.name}`}
                      checked={selectedPaths.includes(p)}
                      onChange={(e) =>
                        setSelectedPaths((all) =>
                          e.target.checked
                            ? [...new Set([...all, p])]
                            : all.filter((x) => x !== p),
                        )
                      }
                    />
                  )}
                  <span className="file-icon">
                    {isVideo(f.name) ? (
                      <Clapperboard size={20} />
                    ) : (
                      <File size={20} />
                    )}
                  </span>
                  <div className="task-name">
                    <strong title={f.relativePath}>{f.name}</strong>
                    <span>{f.task}</span>
                  </div>
                </div>
                <span className="mono small">{bytes(f.size)}</span>
                <span
                  className={
                    verified.length === f.destinations.length
                      ? "green-text small"
                      : "red-text small"
                  }
                >
                  {verified.length} / {f.destinations.length} 历史校验 ·{" "}
                  {verified.filter((copy: any) => copy.online).length} 可访问
                </span>
                <div className="row">
                  <Button
                    kind="icon"
                    title="在 Finder 中显示已校验副本"
                    disabled={!p}
                    onClick={() => p && reveal(p)}
                  >
                    <FolderOpen size={16} />
                  </Button>
                  <Button
                    kind="icon"
                    title="重新定位已移动的副本，或关联另一份完整健康副本"
                    onClick={() =>
                      void api
                        .relinkLibraryFile(f.taskId, f.relativePath)
                        .then((located) => {
                          if (located) {
                            setLocations((current) => ({
                              ...current,
                              [f.id]: located,
                            }));
                            setSelectedPaths([]);
                            setCatalogRevision((value) => value + 1);
                            reveal(located);
                          }
                        })
                        .catch(reportError)
                    }
                  >
                    <RefreshCw size={15} />
                  </Button>
                  {isVideo(f.name) && (
                    <>
                      <Button
                        kind="icon"
                        title="播放素材"
                        disabled={!p}
                        onClick={() =>
                          p && void api.openPath(p).catch(reportError)
                        }
                      >
                        <Play size={15} />
                      </Button>
                      <Button
                        kind="icon"
                        title="查看缩略图和媒体信息"
                        disabled={!p || previewBusy}
                        onClick={() =>
                          p &&
                          (setPreviewBusy(true),
                          api
                            .inspectMedia(p)
                            .then(setPreview)
                            .catch(reportError)
                            .finally(() => setPreviewBusy(false)))
                        }
                      >
                        <Eye size={15} />
                      </Button>
                      <Button
                        kind="subtle"
                        disabled={!p}
                        onClick={() => p && proxy({ name: f.name, path: p })}
                      >
                        生成代理
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <div className="library-footer">
            <span>
              第 {pageIndex + 1} 页 · 本页 {filtered.length} 个文件
              {nextCursor ? " · 还有更多结果" : " · 已到末尾"}·
              记录中的校验状态不代表实时磁盘检测
            </span>
            {pageIndex > 0 && (
              <Button
                kind="subtle"
                onClick={() =>
                  setPagination((current) => ({
                    ...(current.key === pageKey
                      ? current
                      : { key: pageKey, index: 0, cursors: [undefined] }),
                    key: pageKey,
                    index: Math.max(0, pageIndex - 1),
                  }))
                }
              >
                上一页
              </Button>
            )}
            {nextCursor && (
              <Button
                kind="subtle"
                onClick={() =>
                  setPagination((current) => {
                    const base =
                      current.key === pageKey
                        ? current
                        : { key: pageKey, index: 0, cursors: [undefined] };
                    return {
                      key: pageKey,
                      index: pageIndex + 1,
                      cursors: [
                        ...base.cursors.slice(0, pageIndex + 1),
                        nextCursor,
                      ],
                    };
                  })
                }
              >
                下一页
              </Button>
            )}
          </div>
        </>
      ) : (
        <Empty
          icon={Film}
          title={
            catalogBusy
              ? "正在加载素材"
              : catalogError
                ? "素材加载失败"
                : query || kind !== "all"
                  ? "没有找到匹配的素材"
                  : "素材备份后，在这里汇合"
          }
          detail="保留文件结构与校验状态，可在 Finder 中定位副本，或为视频生成剪辑代理。"
        />
      )}
      {preview && (
        <aside
          className="media-preview"
          role="complementary"
          aria-label="媒体检查器"
        >
          <button
            className="media-preview-close"
            title="关闭"
            onClick={() => setPreview(null)}
          >
            <X size={16} />
          </button>
          {preview.thumbnail ? (
            <img src={preview.thumbnail} alt={preview.name} />
          ) : (
            <div className="preview-empty">
              <Clapperboard size={32} />
            </div>
          )}
          <div>
            <strong>{preview.name}</strong>
            <p>
              {preview.camera || "摄影机型号未知"} ·{" "}
              {preview.duration || "时长未知"} · {bytes(preview.size)}
            </p>
            <p>
              {[
                preview.resolution,
                preview.frameRate && `${preview.frameRate} fps`,
                preview.timecode && `TC ${preview.timecode}`,
              ]
                .filter(Boolean)
                .join(" · ") ||
                preview.video ||
                "未识别视频参数"}
            </p>
            {preview.audio && <p>{preview.audio}</p>}
            {preview.creationTime && <p>拍摄时间 {preview.creationTime}</p>}
          </div>
        </aside>
      )}
    </section>
  );
}
function ExistingImportModal({
  value,
  onClose,
  onImported,
}: {
  value: { project: ProjectConfig; preview: ExistingImportPreview };
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [mode, setMode] = useState<
      "manifest-import" | "external-baseline" | "unverified-import"
    >(
      value.preview.manifest && value.preview.detectedStructure === "card"
        ? "manifest-import"
        : "external-baseline",
    ),
    [scope, setScope] = useState<"card" | "day" | "project">(
      value.preview.detectedStructure === "project"
        ? "project"
        : value.preview.detectedStructure === "day"
          ? "day"
          : "card",
    ),
    [dateValue, setDateValue] = useState(
      value.preview.suggestedDate ||
        value.preview.candidates.find((item) => item.shootingDate)
          ?.shootingDate ||
        today(),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [progress, setProgress] = useState<ExistingImportProgress | null>(null);
  const [associationConfirmed, setAssociationConfirmed] = useState(false);
  const [preview, setPreview] = useState(value.preview);
  const [candidateDecisions, setCandidateDecisions] = useState<
    ExistingCandidateDecision[]
  >([]);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    setPreviewBusy(true);
    setError("");
    const timer = setTimeout(
      () =>
        void api
          .previewExistingBackup(
            value.preview.root,
            value.project.id,
            scope,
            dateValue,
          )
          .then((next) => {
            if (!stopped) setPreview(next);
          })
          .catch((error) => {
            if (!stopped) {
              setError(readableOperationError(error));
              setPreview({ ...value.preview, candidates: [] });
            }
          })
          .finally(() => {
            if (!stopped) setPreviewBusy(false);
          }),
      250,
    );
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [value.preview.root, value.project.id, scope, dateValue, previewRetry]);
  const jobIdRef = useRef("");
  useEffect(() => {
    setCandidateDecisions(
      preview.candidates.map((item) => ({
        relativeRoot: item.relativeRoot,
        shootingDate: item.shootingDate || dateValue,
        device: item.device || "",
        cameraPosition: item.cameraPosition,
        card: item.card || "",
      })),
    );
  }, [preview.scanDigest]);
  useEffect(
    () =>
      api.onExistingImportProgress((payload) => {
        if (payload.jobId === jobIdRef.current) setProgress(payload);
      }),
    [],
  );
  const count = preview.candidates.length;
  const mappingKeys = candidateDecisions.map((item) =>
    [
      item.shootingDate,
      item.device.trim(),
      item.cameraPosition?.trim() || "",
      item.card.trim(),
    ].join("\0"),
  );
  const mappingsReady =
    candidateDecisions.length === count &&
    candidateDecisions.every(
      (item) =>
        /^\d{4}-\d{2}-\d{2}$/.test(item.shootingDate) &&
        Boolean(item.device.trim()) &&
        Boolean(item.card.trim()),
    ) &&
    new Set(mappingKeys).size === mappingKeys.length;
  const updateCandidate = (
    relativeRoot: string,
    patch: Partial<ExistingCandidateDecision>,
  ) =>
    setCandidateDecisions((current) =>
      current.map((item) =>
        item.relativeRoot === relativeRoot ? { ...item, ...patch } : item,
      ),
    );
  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-label="接管既有备份"
        aria-busy={busy}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">ADOPT EXISTING MEDIA</span>
            <h2>接管既有备份</h2>
          </div>
          <Button kind="icon" title="关闭" onClick={onClose}>
            <X size={19} />
          </Button>
        </div>
        <div className="form-body">
          <div className="notice">
            <ShieldCheck size={17} />
            <span>
              Kocpy 会按目录结构识别拍摄日、机位和素材卷，并保留外部来源标记。
            </span>
          </div>
          <div className="import-preview">
            <strong>{leaf(preview.root)}</strong>
            <span>
              {preview.files} 个文件 · {bytes(preview.bytes)} · 识别到{" "}
              {preview.candidates.length} 个素材卷 ·
              {preview.detectedStructure === "project"
                ? "项目目录"
                : preview.detectedStructure === "day"
                  ? "单日目录"
                  : preview.detectedStructure === "card"
                    ? "素材卡目录"
                    : "结构待确认"}
            </span>
            <small className="mono">{preview.root}</small>
          </div>
          {preview.warnings.map((warning) => (
            <div className="notice amber" key={warning}>
              <AlertTriangle size={15} />
              {warning}
            </div>
          ))}
          {!!preview.blockingIssues.length && (
            <div className="notice amber">
              <AlertTriangle size={15} />
              <span>
                发现 {preview.blockingIssues.length} 项映射需要确认。Kocpy
                不会把未确认的日期、设备或素材卷写入项目。
              </span>
            </div>
          )}
          <label>
            接管范围
            <select
              disabled={busy || previewBusy}
              value={scope}
              onChange={(event) => setScope(event.target.value as typeof scope)}
            >
              <option value="card">所选文件夹作为单张素材卡</option>
              <option value="day">单日所有机位</option>
              <option value="project">整个项目</option>
            </select>
          </label>
          {scope === "day" && (
            <label>
              拍摄日期
              <input
                type="date"
                disabled={busy}
                value={dateValue}
                onChange={(event) => setDateValue(event.target.value)}
              />
            </label>
          )}
          {previewBusy && <p role="status">正在重新识别所选范围…</p>}
          <div className="import-candidates">
            {preview.candidates.map((item) => {
              const decision = candidateDecisions.find(
                (candidate) => candidate.relativeRoot === item.relativeRoot,
              );
              return (
                <span
                  key={item.relativeRoot}
                  className={item.issues.length ? "needs-confirmation" : ""}
                >
                  <strong>{item.card}</strong>
                  <small>
                    {item.shootingDate || "日期未识别"} ·{" "}
                    {item.device || "设备未识别"}
                    {item.cameraPosition
                      ? ` · ${item.cameraPosition} 机位`
                      : ""}{" "}
                    · {item.files} 文件
                  </small>
                  <small className="mono">{item.relativeRoot}</small>
                  <div className="candidate-mapping-grid">
                    <input
                      type="date"
                      aria-label={`${item.relativeRoot} 拍摄日期`}
                      value={decision?.shootingDate || ""}
                      disabled={busy || previewBusy}
                      onChange={(event) =>
                        updateCandidate(item.relativeRoot, {
                          shootingDate: event.target.value,
                        })
                      }
                    />
                    <input
                      aria-label={`${item.relativeRoot} 设备`}
                      placeholder="设备 / 机位"
                      value={decision?.device || ""}
                      disabled={busy || previewBusy}
                      onChange={(event) =>
                        updateCandidate(item.relativeRoot, {
                          device: event.target.value,
                        })
                      }
                    />
                    <input
                      aria-label={`${item.relativeRoot} 机位`}
                      placeholder="机位（可选）"
                      value={decision?.cameraPosition || ""}
                      disabled={busy || previewBusy}
                      onChange={(event) =>
                        updateCandidate(item.relativeRoot, {
                          cameraPosition: event.target.value,
                        })
                      }
                    />
                    <input
                      aria-label={`${item.relativeRoot} 素材卷`}
                      placeholder="素材卷名称"
                      value={decision?.card || ""}
                      disabled={busy || previewBusy}
                      onChange={(event) =>
                        updateCandidate(item.relativeRoot, {
                          card: event.target.value,
                        })
                      }
                    />
                  </div>
                </span>
              );
            })}
          </div>
          <label>
            接管可信度
            <select
              disabled={busy}
              value={mode}
              onChange={(event) => setMode(event.target.value as typeof mode)}
            >
              <option value="manifest-import">
                根据已有 MHL/SHA 清单重新比对
              </option>
              <option value="external-baseline">
                现在读取全部文件并建立首次基线
              </option>
              <option value="unverified-import">仅导入结构，稍后校验</option>
            </select>
          </label>
          <label className="manifest-confirm">
            <input
              type="checkbox"
              checked={associationConfirmed}
              disabled={busy || previewBusy}
              onChange={(event) =>
                setAssociationConfirmed(event.target.checked)
              }
            />
            <span>
              我确认：只有路径、大小和完整哈希一致的目录才关联为同一逻辑素材卷；同一块物理磁盘上的多个文件夹仍只计一份副本。
            </span>
          </label>
          {progress && (
            <div className="existing-import-progress">
              <div className="row between">
                <strong>{progress.message}</strong>
                <span>
                  {progress.totalBytes
                    ? `${Math.min(100, Math.round((progress.completedBytes / progress.totalBytes) * 100))}%`
                    : "分析中"}
                </span>
              </div>
              <div className="progress-track">
                <i
                  style={{
                    width: `${progress.totalBytes ? Math.min(100, (progress.completedBytes / progress.totalBytes) * 100) : 3}%`,
                  }}
                />
              </div>
              <div className="existing-progress-metrics">
                <span>
                  素材卷 {progress.completedCandidates} /{" "}
                  {progress.totalCandidates || "—"}
                </span>
                <span>
                  文件 {progress.completedFiles} / {progress.totalFiles || "—"}
                </span>
                <span>
                  {bytes(progress.completedBytes)} /{" "}
                  {bytes(progress.totalBytes)}
                </span>
                <span>
                  {progress.speedBps
                    ? `${bytes(progress.speedBps)}/s · 剩余 ${duration(progress.eta)}`
                    : "正在准备读取"}
                </span>
              </div>
              {(progress.currentCandidate || progress.currentFile) && (
                <small className="mono">
                  {progress.currentCandidate || ""}
                  {progress.currentFile ? ` / ${progress.currentFile}` : ""}
                </small>
              )}
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
              <Button
                disabled={busy}
                onClick={() => setPreviewRetry((value) => value + 1)}
              >
                重新识别范围
              </Button>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span className="muted small">将创建 {count} 个独立素材卷记录</span>
          <Button kind="subtle" onClick={onClose}>
            {busy ? "后台继续" : "取消"}
          </Button>
          <Button
            kind="primary"
            disabled={
              busy ||
              previewBusy ||
              !!error ||
              count < 1 ||
              !mappingsReady ||
              !associationConfirmed
            }
            onClick={() => {
              const nextJobId = crypto.randomUUID();
              jobIdRef.current = nextJobId;
              setProgress(null);
              setBusy(true);
              setError("");
              void api
                .importExistingScope(
                  value.project.id,
                  preview.root,
                  mode,
                  scope,
                  dateValue,
                  nextJobId,
                  preview.scanDigest,
                  candidateDecisions,
                  associationConfirmed,
                )
                .then(onImported)
                .catch((reason) =>
                  setError(String(reason).replace(/^Error: /, "")),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Database size={15} />
            )}
            {mode === "unverified-import"
              ? "仅导入结构"
              : mode === "external-baseline"
                ? "读取文件并建立基线"
                : "按外部清单校验并接管"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function ManifestIssueModal({
  task: initialTask,
  onClose,
  onCompleted,
  onUpdated,
}: {
  task: BackupTask;
  onClose: () => void;
  onCompleted: (message: string) => Promise<void>;
  onUpdated: (message: string) => Promise<void>;
}) {
  const [task, setTask] = useState(initialTask),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<ExistingImportProgress | null>(null),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [repairConfirmed, setRepairConfirmed] = useState(false),
    [extraConfirmed, setExtraConfirmed] = useState(false),
    [revisionConfirmed, setRevisionConfirmed] = useState(false),
    [revisionNote, setRevisionNote] = useState(""),
    [revisionPhrase, setRevisionPhrase] = useState("");
  const comparison = task.externalManifest;
  const jobIdRef = useRef("");
  useEffect(() => setTask(initialTask), [initialTask]);
  useEffect(
    () =>
      api.onExistingImportProgress((payload) => {
        if (payload.jobId === jobIdRef.current) setProgress(payload);
      }),
    [],
  );
  if (!comparison) return null;
  const percent = progress?.totalBytes
      ? Math.min(100, (progress.completedBytes / progress.totalBytes) * 100)
      : 0,
    mixedDifference =
      comparison.missing.length > 0 &&
      (comparison.extra.length > 0 ||
        comparison.sizeMismatches.length > 0 ||
        comparison.checksumMismatches.length > 0),
    actualSizes = new Map(
      task.fileRecords.map((record) => [
        record.relativePath.replace(/[\\/]+/g, "/").normalize("NFC"),
        record.size,
      ]),
    ),
    zeroByteExtras = comparison.extra.filter(
      (relativePath) =>
        actualSizes.get(
          relativePath.replace(/[\\/]+/g, "/").normalize("NFC"),
        ) === 0,
    ),
    extraOnly =
      comparison.extra.length > 0 &&
      !comparison.missing.length &&
      !comparison.sizeMismatches.length &&
      !comparison.checksumMismatches.length,
    canAcceptExtra =
      extraOnly &&
      task.status === "completed" &&
      task.confidence === "baseline" &&
      !comparison.resolution,
    canReviseMissing =
      comparison.missing.length > 0 &&
      !comparison.extra.length &&
      !comparison.sizeMismatches.length &&
      !comparison.checksumMismatches.length &&
      /\.mhl$/i.test(comparison.path);
  const remainingDifference = (value: BackupTask) => {
    const manifest = value.externalManifest;
    if (!manifest || manifest.status !== "mismatch") return "";
    return [
      manifest.missing.length && `缺少 ${manifest.missing.length}`,
      manifest.extra.length && `额外 ${manifest.extra.length}`,
      manifest.sizeMismatches.length &&
        `大小不同 ${manifest.sizeMismatches.length}`,
      manifest.checksumMismatches.length &&
        `校验不同 ${manifest.checksumMismatches.length}`,
    ]
      .filter(Boolean)
      .join("、");
  };
  const applyVerificationResult = async (
    verified: BackupTask,
    completedMessage: string,
    partialPrefix = "完整核对已完成",
  ) => {
    const remaining = remainingDifference(verified);
    if (
      remaining &&
      verified.externalManifest?.resolution?.type !== "accepted-extra"
    ) {
      setTask(verified);
      setRepairConfirmed(false);
      setExtraConfirmed(false);
      setRevisionConfirmed(false);
      const message = `${partialPrefix}；仍需处理：${remaining}`;
      setSuccess(message);
      await onUpdated(message);
      return;
    }
    await onCompleted(completedMessage);
  };
  const reverify = async (jobId = crypto.randomUUID()) => {
    jobIdRef.current = jobId;
    setProgress(null);
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const verified = await api.reverifyExistingManifest(task.id, jobId);
      await applyVerificationResult(
        verified,
        verified.externalManifest?.resolution?.type === "accepted-extra"
          ? "完整核对完成，已确认的额外文件集合没有变化"
          : "外部清单完整校验通过，项目收工状态已刷新",
      );
    } catch (reason) {
      setError(readableError(reason));
    } finally {
      setBusy(false);
    }
  };
  const list = (
    title: string,
    values: Array<string | { path: string; label: string }>,
    tone: "missing" | "extra" | "different",
  ) =>
    values.length ? (
      <section className="manifest-difference-group">
        <div className="row between">
          <strong>{title}</strong>
          <span>{values.length} 项</span>
        </div>
        <div className="manifest-file-list">
          {values.map((value) => {
            const relativePath = typeof value === "string" ? value : value.path,
              label = typeof value === "string" ? value : value.label;
            return (
              <div key={`${tone}-${relativePath}`}>
                <span className="mono">{label}</span>
                <button
                  title={
                    tone === "missing" ? "显示目标目录" : "在 Finder 中显示"
                  }
                  onClick={() =>
                    void api.revealExistingManifestItem(task.id, relativePath)
                  }
                >
                  <FolderOpen size={13} />
                  Finder
                </button>
              </div>
            );
          })}
        </div>
      </section>
    ) : null;
  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal manifest-issue-modal"
        role="dialog"
        aria-modal="true"
        aria-label="处理外部清单差异"
        aria-busy={busy}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">MANIFEST DIFFERENCE</span>
            <h2>处理外部清单差异</h2>
          </div>
          <Button kind="icon" title="关闭" onClick={onClose}>
            <X size={19} />
          </Button>
        </div>
        <div className="form-body">
          <details className="context-help">
            <summary>这是什么意思 / 下一步怎么做</summary>
            <p>
              这里按外部清单记录的相对路径、大小和哈希核对当前目录，不根据项目名称推测素材总量。缺失文件先尝试从同一卷健康副本补回；有意剔除内容须走保留原清单与审计的修订流程。额外文件和缺失文件不是同一类差异，读取
              100% 也不表示差异已经消失。
            </p>
          </details>
          <div className="notice amber">
            <AlertTriangle size={17} />
            <span>
              这是当前素材卷与外部清单的真实逐路径对比。红色状态不会自动算作安全副本；修复或确认后会保留审计记录。
            </span>
          </div>
          {mixedDifference && (
            <div className="manifest-workflow-notice">
              <strong>这是混合差异，请按顺序处理</strong>
              <ol>
                <li>先从健康副本补回清单缺少的文件。</li>
                <li>Kocpy 自动重新完整核对，并保留已经成功的修复。</li>
                <li>
                  再检查剩余的额外文件：误放或空文件应移出素材卷；有效文件应建立当前哈希基线后确认。
                </li>
              </ol>
            </div>
          )}
          {!!comparison.pathCollisionHints?.length && (
            <div className="notice amber manifest-collision-notice">
              <Info size={17} />
              <div>
                <strong>
                  发现 {comparison.pathCollisionHints.length} 组疑似同名冲突
                </strong>
                <p>
                  文件名相似不代表内容相同，Kocpy
                  不会把带“(1)”的清单文件与另一个文件自动视为同一文件。
                </p>
                {comparison.pathCollisionHints.map((hint) => (
                  <small
                    className="mono"
                    key={`${hint.missingPath}-${hint.extraPath}`}
                  >
                    清单：{hint.missingPath} ·{" "}
                    {hint.expectedSize === undefined
                      ? "大小未记录"
                      : bytes(hint.expectedSize)}
                    <br />
                    当前：{hint.extraPath} · {bytes(hint.actualSize)}
                  </small>
                ))}
              </div>
            </div>
          )}
          {!!zeroByteExtras.length && (
            <div className="notice amber compact">
              <AlertTriangle size={16} />
              <span>
                发现 {zeroByteExtras.length} 个 0
                字节额外文件。空文件不能替代清单中的有效素材；建议先在 Finder
                中确认并移出素材卷，不建议直接采用为可信基线。
              </span>
            </div>
          )}
          <div className="import-preview">
            <strong>
              {task.shootingDate?.replace(/-/g, "")} · {task.devices.join("/")}{" "}
              · {task.name}
            </strong>
            <span>
              清单 {comparison.entries} 项 · 当前匹配 {comparison.matched} 项
            </span>
            <small className="mono">{task.sourcePath}</small>
            <div className="row wrap manifest-path-actions">
              <Button
                kind="subtle"
                onClick={() => void api.revealExistingManifestItem(task.id)}
              >
                <FolderOpen size={14} />
                素材卷目录
              </Button>
              <Button
                kind="subtle"
                onClick={() => void api.reveal(comparison.path)}
              >
                <FileCheck2 size={14} />
                外部清单
              </Button>
            </div>
          </div>
          {list("清单有记录、当前目录缺少", comparison.missing, "missing")}
          {list("当前目录存在、清单没有记录", comparison.extra, "extra")}
          {list(
            "文件大小不同",
            comparison.sizeMismatches.map((item) => ({
              path: item.relativePath,
              label: `${item.relativePath} · 清单 ${bytes(item.expected)} / 当前 ${bytes(item.actual)}`,
            })),
            "different",
          )}
          {list("文件校验值不同", comparison.checksumMismatches, "different")}
          {comparison.missing.length > 0 && (
            <div className="manifest-action-card">
              <strong>
                {mixedDifference ? "第 1 步：先补回缺失文件" : "补回缺失文件"}
              </strong>
              <p>
                可选择同一张素材卡、对应素材子目录或其上级目录。Kocpy
                只接受唯一一致的目录映射，并会在写入前按清单预检全部缺失文件；全部通过后才暂存、提交并自动完整重校验。
              </p>
              <label className="manifest-confirm">
                <input
                  type="checkbox"
                  checked={repairConfirmed}
                  onChange={(event) => setRepairConfirmed(event.target.checked)}
                  disabled={busy}
                />
                <span>
                  我确认将选择同一素材卷的健康副本，并允许补回缺失文件。
                </span>
              </label>
              <Button
                kind="primary"
                disabled={busy || !repairConfirmed}
                onClick={() => {
                  const jobId = crypto.randomUUID();
                  jobIdRef.current = jobId;
                  setProgress(null);
                  setError("");
                  setSuccess("");
                  setBusy(true);
                  void api
                    .repairExistingManifest(task.id, jobId)
                    .then(async (result) => {
                      if (!result) return;
                      setProgress(null);
                      const verified = await api.reverifyExistingManifest(
                        task.id,
                        jobId,
                      );
                      await applyVerificationResult(
                        verified,
                        `已从 ${leaf(result.sourceRoot)} 映射到 ${result.manifestRoot}，安全补回 ${result.files} 个文件并通过完整清单校验`,
                        `已安全补回 ${result.files} 个缺失文件`,
                      );
                    })
                    .catch((reason) => setError(readableError(reason)))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <ShieldCheck size={15} />
                )}
                {mixedDifference
                  ? "选择健康副本，补回后继续检查"
                  : "选择健康副本并修复、校验"}
              </Button>
            </div>
          )}
          {canReviseMissing && (
            <div className="manifest-action-card manifest-revision-card">
              <strong>确认这些素材已被有意剔除，并修订 MHL</strong>
              <div className="notice amber compact">
                <AlertTriangle size={16} />
                <span>
                  这是不可忽略的重要定义变更：修订后，绿色通过只证明“保留素材集合”完整，不再证明它与原数据卡全部内容一致。原始
                  MHL 会先保存到 Kocpy 审计历史，不会被无痕删除。
                </span>
              </div>
              <p>
                仅当上方 {comparison.missing.length}{" "}
                个文件确实由操作人主动剔除、无需补回时使用。大小不同、哈希不同或额外文件不能通过此功能消除。
              </p>
              <label>
                素材剔除原因
                <input
                  value={revisionNote}
                  onChange={(event) => setRevisionNote(event.target.value)}
                  placeholder="例如：客户隐私要求，禁止对外移交"
                  maxLength={500}
                  disabled={busy}
                />
              </label>
              <label className="manifest-confirm">
                <input
                  type="checkbox"
                  checked={revisionConfirmed}
                  onChange={(event) =>
                    setRevisionConfirmed(event.target.checked)
                  }
                  disabled={busy}
                />
                <span>
                  我确认这些文件是有意剔除，不是漏拷、损坏或误删；我理解原始清单与修订清单将保留审计关联。
                </span>
              </label>
              <label>
                输入“修改 MHL”确认
                <input
                  value={revisionPhrase}
                  onChange={(event) => setRevisionPhrase(event.target.value)}
                  placeholder="修改 MHL"
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
              <Button
                kind="danger"
                disabled={
                  busy ||
                  !revisionConfirmed ||
                  revisionNote.trim().length < 2 ||
                  revisionPhrase.trim() !== "修改 MHL"
                }
                onClick={() => {
                  const jobId = crypto.randomUUID();
                  jobIdRef.current = jobId;
                  setProgress(null);
                  setError("");
                  setBusy(true);
                  void api
                    .reviseExistingManifestMissing(
                      task.id,
                      revisionNote,
                      revisionPhrase,
                    )
                    .then(async (result) => {
                      await api.reverifyExistingManifest(task.id, jobId);
                      await onCompleted(
                        `已从生效 MHL 排除 ${result.excluded.length} 个有意剔除记录，原始清单已保存到审计历史，并通过完整重校验`,
                      );
                    })
                    .catch((reason) => setError(readableError(reason)))
                    .finally(() => setBusy(false));
                }}
              >
                <AlertTriangle size={15} />
                修订 MHL 并重新完整校验
              </Button>
            </div>
          )}
          {extraOnly && (
            <div className="manifest-action-card">
              <strong>下一步：处理额外文件</strong>
              <p>
                如果它是误放文件或 0 字节空文件，请先在 Finder
                中将其移出素材卷，再点击“重新完整核对”。如果它确属有效素材，可建立当前完整哈希基线后确认保留。此操作不会修改原
                MHL。
              </p>
              {!canAcceptExtra && !comparison.resolution && (
                <div className="notice amber compact">
                  <Info size={15} />
                  <span>
                    确认保留前必须逐文件读取当前素材卷并建立完整哈希基线，可直接在这里完成。
                  </span>
                </div>
              )}
              {!canAcceptExtra && !comparison.resolution && (
                <Button
                  kind="subtle"
                  disabled={busy}
                  onClick={() => {
                    const jobId = crypto.randomUUID();
                    jobIdRef.current = jobId;
                    setProgress(null);
                    setError("");
                    setSuccess("");
                    setBusy(true);
                    void api
                      .establishExistingBaseline(task.id, jobId)
                      .then(async (baselined) => {
                        setTask(baselined);
                        const message =
                          "当前素材卷已逐文件读取并建立完整哈希基线；请检查额外文件后再确认是否保留";
                        setSuccess(message);
                        await onUpdated(message);
                      })
                      .catch((reason) => setError(readableError(reason)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <ShieldCheck size={15} />
                  )}
                  建立当前完整哈希基线
                </Button>
              )}
              <label className="manifest-confirm">
                <input
                  type="checkbox"
                  checked={extraConfirmed}
                  onChange={(event) => setExtraConfirmed(event.target.checked)}
                  disabled={busy || !canAcceptExtra}
                />
                <span>我已检查文件内容，确认它属于这份素材卷并应被保留。</span>
              </label>
              <Button
                kind="primary"
                disabled={busy || !canAcceptExtra || !extraConfirmed}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  setSuccess("");
                  void api
                    .acceptExistingManifestExtra(task.id)
                    .then(() =>
                      onCompleted(
                        "额外文件已确认；外部清单差异已保留在审计记录中",
                      ),
                    )
                    .catch((reason) => setError(readableError(reason)))
                    .finally(() => setBusy(false));
                }}
              >
                <Check size={15} />
                确认额外文件并采用当前基线
              </Button>
            </div>
          )}
          {progress && (
            <div className="existing-import-progress">
              <div className="row between">
                <strong>{progress.message}</strong>
                <span>{Math.round(percent)}%</span>
              </div>
              <div className="progress-track">
                <i style={{ width: `${percent}%` }} />
              </div>
              <div className="existing-progress-metrics">
                <span>
                  文件阶段 {progress.completedFiles} / {progress.totalFiles}
                </span>
                <span>
                  {bytes(progress.completedBytes)} /{" "}
                  {bytes(progress.totalBytes)}
                </span>
                <span>
                  {progress.speedBps
                    ? `${bytes(progress.speedBps)}/s`
                    : "准备读取"}
                </span>
                <span>
                  {progress.eta ? `剩余 ${duration(progress.eta)}` : "—"}
                </span>
              </div>
              {progress.currentFile && (
                <small className="mono">{progress.currentFile}</small>
              )}
            </div>
          )}
          {success && (
            <div className="success-box" role="status">
              <CheckCircle2 size={17} />
              {success}
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button kind="subtle" onClick={onClose}>
            关闭
          </Button>
          <Button kind="subtle" disabled={busy} onClick={() => void reverify()}>
            <RefreshCw size={14} />
            重新完整核对
          </Button>
        </div>
      </section>
    </div>
  );
}

function ExistingBaselineModal({
  task,
  onClose,
  onCompleted,
}: {
  task: BackupTask;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<ExistingImportProgress | null>(null),
    [error, setError] = useState("");
  const jobIdRef = useRef("");
  useEffect(
    () =>
      api.onExistingImportProgress((payload) => {
        if (payload.jobId === jobIdRef.current) setProgress(payload);
      }),
    [],
  );
  const percent = progress?.totalBytes
    ? Math.min(100, (progress.completedBytes / progress.totalBytes) * 100)
    : 0;
  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-label="建立首次哈希基线"
        aria-busy={busy}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">ESTABLISH BASELINE</span>
            <h2>建立首次哈希基线</h2>
          </div>
          <Button kind="icon" title="关闭" onClick={onClose}>
            <X size={19} />
          </Button>
        </div>
        <div className="form-body">
          <details className="context-help">
            <summary>首次基线能证明什么？</summary>
            <p>
              读取当前目录并记录哈希，供今后复校验使用；不证明原始素材卡曾经有多少文件，也不会自动消除外部清单差异。
            </p>
          </details>
          <div className="notice amber">
            <ShieldCheck size={17} />
            <span>
              Kocpy
              将完整读取现存文件并记录哈希。这可以证明以后文件是否变化，但不能追溯证明最初从素材卡接收时已经校验。
            </span>
          </div>
          <div className="import-preview">
            <strong>{task.name}</strong>
            <span>
              {task.totalFiles} 个文件 · {bytes(task.totalBytes)} ·{" "}
              {task.devices.join(" / ") || "未分类设备"}
            </span>
            <small className="mono">{task.sourcePath}</small>
          </div>
          {progress && (
            <div className="existing-import-progress">
              <div className="row between">
                <strong>{progress.message}</strong>
                <span>{Math.round(percent)}%</span>
              </div>
              <div className="progress-track">
                <i style={{ width: `${percent}%` }} />
              </div>
              <div className="existing-progress-metrics">
                <span>
                  文件 {progress.completedFiles} / {progress.totalFiles}
                </span>
                <span>
                  {bytes(progress.completedBytes)} /{" "}
                  {bytes(progress.totalBytes)}
                </span>
                <span>
                  {progress.speedBps
                    ? `${bytes(progress.speedBps)}/s`
                    : "准备读取"}
                </span>
                <span>
                  {progress.eta ? `剩余 ${duration(progress.eta)}` : "—"}
                </span>
              </div>
              {progress.currentFile && (
                <small className="mono">{progress.currentFile}</small>
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
          <Button kind="subtle" onClick={onClose}>
            取消
          </Button>
          <Button
            kind="primary"
            disabled={busy}
            onClick={() => {
              const nextJobId = crypto.randomUUID();
              jobIdRef.current = nextJobId;
              setProgress(null);
              setError("");
              setBusy(true);
              void api
                .establishExistingBaseline(task.id, nextJobId)
                .then(onCompleted)
                .catch((reason) =>
                  setError(String(reason).replace(/^Error: /, "")),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <ShieldCheck size={15} />
            )}
            开始完整读取
          </Button>
        </div>
      </section>
    </div>
  );
}

function HelpPage({
  go,
  openBackup,
}: {
  go: (page: Page) => void;
  openBackup: () => void;
}) {
  const [helpQuery, setHelpQuery] = useState("");
  useEffect(() => {
    const context = sessionStorage.getItem("kocpy-help-context");
    sessionStorage.removeItem("kocpy-help-context");
    if (context) {
      const target = document.querySelector<HTMLDetailsElement>(
        `details[data-page="${context}"]`,
      );
      if (target) {
        target.open = true;
        target.scrollIntoView({ block: "start" });
      }
    }
  }, []);
  const guides: Array<{
    id: string;
    icon: typeof HardDrive;
    title: string;
    purpose: string;
    steps: string[];
    tips: string[];
    page?: Page;
  }> = [
    {
      id: "interaction-safety",
      icon: ShieldCheck,
      title: "操作范围、后台任务与安全确认",
      purpose: "理解取消、进度、基线与安全结论；管理检查表、提醒和 NAS。",
      steps: [
        "接管范围改变后等待新预览，滚动核对全部候选卷；仅导入结构不会建立基线。",
        "复校验必须明确项目、日期、素材卷或文件；缺少参数不会扩大范围。",
        "批次失败后只重试未提交项；已创建任务留在传输列表，参数不再变更。",
        "在维护中选择拍摄日、检查阶段和实际签署人，逐项勾选；未处理的收工风险仍会阻止签署。",
        "后台操作可在切页后查看；修复/提交阶段不支持强制取消，结束前勿强制退出。",
        "报告选择日期和项目，批量推出确认设备清单；NAS 预设可编辑并直接选为目的地。",
        "在局域网区域填写另一工作站的内网地址与令牌，即可只读查看元数据，无需命令行。",
      ],
      tips: [
        "读取到 100% 不等于校验通过；外部基线只证明建立时的文件，不证明历史拍摄总量完整。",
        "刷新只更新记录，不会替代重新读取文件哈希。路径可访问也不等于重新校验通过。",
        "镜像保留源文件夹，但不会删除目的地额外文件；删除项目记录不会删除磁盘素材。",
        "诊断只是本次 64 MiB / 1000 小文件读写检查，不代表所有现场故障场景通过。",
        "桌面键盘、最小窗口与真实 Intel 设备仍须按发布验证记录人工验收。",
      ],
      page: "maintenance",
    },
    {
      id: "backup",
      icon: MemoryStick,
      title: "新建备份",
      purpose: "从素材卡或文件夹向 1–4 个目的地复制，并逐目标独立回读校验。",
      steps: [
        "连接素材卡，点击“新建备份”并选择素材来源。",
        "默认普通备份，无需创建项目；需要拍摄日、设备和机位管理时再选择项目备份。",
        "普通备份内选择按次保存（推荐）或保留源文件夹（镜像备份）；目的地统一选择存放副本的父目录。",
        "普通备份保存为“源文件夹名_时间戳”；镜像备份保留所选源文件夹这一层，不添加时间戳。开始前核对每个来源的最终路径。",
        "扫描统计中的数字是各类型的文件数，不是卷数；其他／附属文件也会备份。源和目的地均支持从 Finder 拖入文件夹。",
        "选择位于不同物理磁盘的目的地并开始；紫色表示拷贝，绿色表示独立校验。",
      ],
      tips: [
        "Kocpy 不会自动开始写入。",
        "“疑似重复”只依据相对路径和字节数，不等于重新读取哈希；历史卷建议会列出卷身份依据，点击应用也只填写草稿，仍需最终确认。",
        "高级选项默认折叠，哈希与逐目标独立回读始终开启；容量未知显示待预检，不当作通过。",
        "预计时间仅指当前阶段。暂停清空速度与预计时间，继续后重新采样；预检和测速不足时显示横线。字节100%仍需等待最终校验结论。",
        "任务详情和拍摄项目素材卷明细会实时更新速度与进度，无需关闭重开。暂停/继续会即时更新状态，当前小块读写或安全落盘可能需要收尾。",
        "全新文件边复制边计算源哈希，之后仍独立回读每个目标。完整备份含校验，与只复制的耗时不是同一指标。",
        "升级前创建的旧镜像任务恢复时保留旧目录落点，不会自动移动已备份文件；新建镜像任务才采用保留源文件夹的布局。",
        "不要把多个目录位于同一物理盘误当成独立副本。",
        "校验完成前不要拔出素材卡或目的地。",
        "完成判定前会重新扫描素材源；复制期间新增、删除或修改文件会停止任务，避免生成不完整的成功记录。",
      ],
    },
    {
      id: "window-layout",
      icon: LayoutDashboard,
      title: "窗口与页面布局",
      purpose: "根据当前显示器自动选择初始尺寸，在最小窗口下保留全部功能入口。",
      steps: [
        "首次打开时，Kocpy 会读取当前显示器的可用工作区域并把窗口完整放入屏幕。",
        "窗口高度较小时，侧栏文字、图标、品牌和按钮保持正常比例；滚动中间导航区域即可访问全部模块。",
        "长页面在主内容区独立滚动；窄窗口中的大型表格可以横向滚动，不会被边界直接裁掉。",
        "窗口可缩小到 1080 × 720；更小的显示器会以其实际可用工作区域作为安全下限。",
      ],
      tips: [
        "滚动内容页不会带走左侧导航和顶部状态栏。",
        "新建备份等弹窗会限制在窗口内部，内容过长时由弹窗内部滚动。",
      ],
    },
    {
      id: "transfers",
      icon: ArrowLeftRight,
      title: "传输队列",
      purpose:
        "查看素材类型、源路径、每个目的地路径、百分比、真实速度和校验状态。",
      steps: [
        "先通过任务图标辨认视频、照片/RAW、音频、混合素材或其他素材卷；图标颜色表示当前任务状态。",
        "任务条目直接显示完整源路径和每个目的地的最终路径；点击任一路径可在 Finder 中显示。",
        "点击任务其余区域查看拷贝、校验和最近 30 秒速度。",
        "需要时暂停；继续后会使用安全检查点。",
        "失败时先阅读具体目标和文件错误，再进入恢复中心。",
      ],
      tips: [
        "“已保存”是最终有效素材量；“本次写入”是本轮物理写入量。",
        "速度来自操作系统确认完成的字节，不是模拟数据。",
        "长路径会完整换行显示；目的地采用任务实际写入后的最终路径。",
      ],
      page: "transfers",
    },
    {
      id: "recovery",
      icon: RefreshCw,
      title: "恢复中心",
      purpose: "处理异常退出、离线磁盘、断点文件和未完成校验。",
      steps: [
        "重新连接原素材卡与原目标磁盘。",
        "失败任务点击“检查并恢复”，再点击“只读检查连接与身份”，核对记录身份、当前 UUID、路径、实际挂载点和可用空间。",
        "身份一致且路径可访问时，勾选确认后“重试未通过目标”；写入前仍会再次检查身份、空间和断点。",
        "身份暂时无法读取时先处理连接或权限；确认换盘或格式化后应另建任务，不能覆盖旧 UUID。暂停任务仍可从安全检查点继续。",
        "恢复后检查成功目标是否仍保持通过。",
      ],
      tips: [
        "UUID 查询失败不表示已经换盘。0.1.19 修复了子目录查询失败被误报为 UUID 变化的问题。",
        "同一路径换成另一块磁盘时会拒绝继续。",
        "失败目标修复不会重新写入已成功目标。",
        "只读检查不是素材校验。接管素材请走基线或清单处理；没有完整哈希基线的任务不能通过复校验获得安全状态。",
      ],
      page: "recovery",
    },
    {
      id: "projects",
      icon: FolderKanban,
      title: "拍摄项目",
      purpose: "按日期、设备、机位和物理独立副本管理完整拍摄周期。",
      steps: [
        "创建项目并设置拍摄周期、设备、机位和目的地。",
        "设置收工需要的独立副本数量。",
        "每天填写实际操作人并查看日期 × 设备矩阵；确认应该有素材、当天未使用或整日休息。每次决定都会追加审计记录。",
        "临时航拍、录音或外部设备可指定拍摄日和机位加入当日，不会自动扩展到整个项目。",
        "修改项目名称／拍摄周期、设备、副本要求、目的地、命名或检查表时填写规则修改人；Kocpy 追加新规则版本，不改写旧素材卷和签署记录。",
        "模板应用前核对逐项预览并填写应用人；交接时选择单日或全项目，填写交接人、说明和例外。",
        "项目结束后导出 PDF、JSON、CSV 或完整归档包。",
        "需要重新做一次全流程测试时，在进行中或已归档项目卡片右上角打开更多菜单，选择删除项目记录。",
        "核对关联记录数量、勾选风险确认并输入完整项目名称；未结束任务会阻止删除。",
      ],
      tips: [
        "同一磁盘的多个文件夹只计算一份安全副本。",
        "不同卷 UUID 不等于物理独立。校验后按同次系统拓扑计数；NAS、未知阵列或旧记录没有证据时不自动增加第二份。",
        "旧任务显示独立性证据不足不等于文件损坏。连接原目标重新校验可更新关系，原哈希记录保留；存储拓扑不能证明机箱、供电或灾备独立。",
        "休息／未使用只解释空白单元，已有素材仍按校验、清单和副本要求检查。",
        "“当天未发现素材 · 待确认”不等于漏备份，也不等于当天未使用。",
        "同一素材卷失败重试或恢复仍按一个逻辑素材卷统计；明细中的尝试次数不增加收工分母。",
        "交接记录冻结当时规则版本和收工摘要；之后修改项目规则不会倒改历史交接。规则记录是本地审计证据，不是第三方数字签名。",
        "项目模板可自定义名称、说明、设备、机位、素材卷前缀、副本标准、命名规则、检查表、制作人员和完成动作建议；应用前可逐项预览并选择覆盖范围。",
        "任务完成只建立动作建议，不会后台生成文件、加入代理或推出磁盘。进入任务详情填写操作人并逐项确认；重复执行不会覆盖产物或重复入队。",
        "完成动作失败会保留错误和授权尝试；重启中断不会算作成功。安全推出每次都重新核对源盘身份和占用，不能永久授权。",
        "进行中和已归档项目都能从卡片右上角菜单删除内部记录。删除前必须勾选风险确认并准确输入项目名称；活动备份或代理任务会阻止删除。",
        "删除项目只清理 Kocpy 内部的项目配置、任务索引、代理记录和归档维护历史；不会删除素材、备份目录、报告、MHL 或已导出的冷归档文件。",
      ],
      page: "projects",
    },
    {
      id: "library",
      icon: Film,
      title: "素材库",
      purpose: "浏览已记录素材、缩略图、元数据与已校验副本。",
      steps: [
        "按视频、照片/RAW、LUT/CDL 分类或搜索。",
        "使用 Finder、播放和媒体信息三个独立操作。",
        "磁盘改名或目录移动后，点击重新定位并选择新的副本根目录；哈希一致才会接管新路径。",
        "只从已校验副本创建代理。",
      ],
      tips: ["历史绿色状态是任务执行时的记录；长期状态请使用归档复校验。"],
      page: "library",
    },
    {
      id: "proxy",
      icon: Clapperboard,
      title: "代理队列",
      purpose: "生成 H.264 或 ProRes 剪辑代理并检查媒体一致性。",
      steps: [
        "在素材库选择一个或多个已校验视频。",
        "选择审片、剪辑或离线预设，并设置尺寸、封装和命名规则。ProRes Proxy 只允许 MOV。",
        "需要复用参数时输入名称保存自定义预设；项目可设置完成后建议加入代理队列，但仍需在任务详情逐项授权。",
        "入队后参数与源哈希被冻结；转码前完整重读源文件，在队列中可暂停、继续、取消或重试。",
        "完成后检查输出 SHA-256，以及时长、帧率、时间码、音轨、旋转和色彩提示。未知字段不会自动算作通过。",
        "优先使用“生成交付目录”，让 Kocpy 在发布前重新校验输出并生成媒体、清单和检查报告。",
      ],
      tips: [
        "代理始终写入独立目录，不修改原素材。",
        "暂停会清理不完整输出，继续时安全重建。",
        "0.1.28 以前完成的代理没有新输出证据，需从素材库重新生成后才能进入正式交付。",
        "固定 H.264／ProRes Proxy 样本已在 Resolve 实际导入；Premiere CSV 与 Final Cut XML 因本机未安装对应软件，仅完成格式检查。",
        "内置 FFmpeg 9.0.1 与 x264 的完整许可证、对应源码、构建脚本和摘要随应用资源及同版 Release 提供，无需另装组件。",
      ],
      page: "processing",
    },
    {
      id: "reports",
      icon: FileCheck2,
      title: "报告中心",
      purpose: "导出单任务、拍摄日和项目级校验记录。",
      steps: [
        "选择任务或拍摄日。",
        "选择 PDF、JSON、MHL、ASC MHL 或 Resolve CSV。",
        "项目归档包同时包含报告、数据、统计、MHL 和 SHA-256。",
      ],
      tips: [
        "PDF 可包含素材首帧缩略图。",
        "报告证明任务执行时状态，不替代后续长期复校验。",
        "MHL 使用已校验副本的真实最终路径；若重名策略改了文件名，清单也会记录改名后的路径。",
      ],
      page: "reports",
    },
    {
      id: "storage",
      icon: HardDrive,
      title: "存储设备",
      purpose: "查看容量、文件系统、网络延迟并安全推出设备。",
      steps: [
        "确认目标可写、容量充足且不是系统备份卷。",
        "任务完成后使用安全推出。",
        "批量推出会保留仍被备份、代理或失败记录占用的磁盘。",
      ],
      tips: ["不要直接拔出正在写入或校验的设备。"],
      page: "storage",
    },
    {
      id: "diagnostics",
      icon: Gauge,
      title: "诊断中心",
      purpose: "执行受控性能预检并导出脱敏诊断包。",
      steps: [
        "确保没有备份或代理任务运行。",
        "对选定可写磁盘运行 64 MiB 写入与回读测试。",
        "首次使用新介质时运行可靠性验收，实际写入 64 MiB 大文件与 1000 个小文件并独立回读。",
        "遇到问题时导出诊断包。",
      ],
      tips: [
        "测试文件会自动清理。",
        "诊断包不包含素材内容、完整私人路径或账号。",
      ],
      page: "diagnostics",
    },
    {
      id: "archive",
      icon: Database,
      title: "归档维护",
      purpose: "长期复校验、修复副本、数据备份与工作站合并。",
      steps: [
        "按整盘、项目、拍摄日、素材卷或单文件选择复校验范围。",
        "对归档根目录扫描未登记新增文件，并查看读取吞吐与风险等级。",
        "发现失败副本后，从另一健康副本修复。",
        "修复前原损坏文件会改名保留。",
        "在项目模板区查看五个系统模板的适用说明；需要修改时先复制为自定义模板，或直接新建模板。",
        "应用模板前逐项比较当前配置和模板配置，只勾选需要覆盖的部分；项目名称、日期和目的地不会被模板修改。",
        "自定义模板可导入导出；系统模板可隐藏并恢复。",
        "导出本地数据备份或工作站包。",
        "合并其他工作站记录后检查重复项和冲突。",
      ],
      tips: [
        "修复必须至少存在一份哈希匹配的健康副本。",
        "导入前建议先导出本地数据备份。",
        "模板要求的副本数超过项目目的地数量时不会应用，应先补齐目的地或取消该项。",
      ],
      page: "maintenance",
    },
    {
      id: "adopt",
      icon: FolderPlus,
      title: "接管既有备份",
      purpose: "把单张卡、单日全部机位或整个历史项目纳入 Kocpy，并明确可信度。",
      steps: [
        "在项目卡片选择“接管既有备份”。",
        "选择单张素材卡、拍摄日根目录或项目根目录。",
        "逐卷检查日期、设备、机位、卷名和相对根目录；缺失或重复映射必须先修正，项目外名称会保留为实际设备名称。",
        "有 MHL/SHA 清单时选择清单比对；否则建立接管时基线或仅导入结构。",
        "确认完整哈希相同的路径关联为同一逻辑卷；同盘多个目录仍只计一份。",
        "确认后通过素材卷、文件、字节、速度和预计时间查看读取进度；目录变化会整批停止且不落库。",
        "只有清单通过或首次基线建立完成的记录才计为可信物理副本。",
      ],
      tips: [
        "目录命名越规范，自动识别越准确。",
        "接管时基线只证明接管当时的内容，不等于原始现场校验。",
        "未验证导入不会显示为安全副本。",
        "任务详情可展开接管与维护审计；旧路径、清单决定和证据摘要不会被后续操作覆盖。",
        "没有发现设备文件夹只表示待确认；确认未使用后才会从收工缺口中跳过。",
      ],
      page: "projects",
    },
    {
      id: "refresh-adopted",
      icon: RefreshCw,
      title: "刷新既有项目（0.1.8）",
      purpose: "清理误识别的父级汇总记录，并按卡卷清单重新判断真实差异。",
      steps: [
        "打开拍摄项目并进入项目详情。",
        "点击“刷新接管信息”，先查看待修正元数据、重复素材卷、误识别父级汇总、清单差异和离线来源数量。",
        "确认后等待项目卡片、日期设备矩阵和素材卷明细重新计算。",
        "若来源当前离线，原记录会保留；重新连接磁盘后可以再次刷新。",
        "若目录是后来新增且从未接管，请使用“接管既有备份”，刷新不会自动导入新目录。",
      ],
      tips: [
        "同一绝对路径始终按一个逻辑素材卷统计。",
        "不同路径只有完整文件哈希一致时才会合并为同一素材卷的多个副本。",
        "刷新读取卡卷根目录中的 MHL/SHA 清单路径与文件大小，不重新计算素材哈希，不复制、移动、改名或删除素材文件。",
        "“缺少”表示清单有记录但磁盘没有；“额外”表示磁盘有文件但清单没有；两者都需要人工核对。",
        "刷新只整理外部接管记录，不修改 Kocpy 正常复制产生的任务。",
      ],
      page: "projects",
    },
    {
      id: "coverage",
      icon: Layers,
      title: "项目素材覆盖",
      purpose: "区分已记录、已验证、副本达标和需要处理的素材卷。",
      steps: [
        "为项目填写预计素材卷数量；未知时保持为空。",
        "设置 Kocpy 管理起始日期。",
        "项目卡片分别查看 Kocpy 接收与外部接管数量。",
        "只在有明确计划总量时使用覆盖百分比。",
      ],
      tips: [
        "Kocpy 不推测接管前未知的拍摄量。",
        "素材卷数量按唯一逻辑素材卷计算，不按文件夹内的片段数计算。",
        "副本达标按不同物理卷计算。",
      ],
      page: "projects",
    },
    {
      id: "manifest-differences",
      icon: AlertTriangle,
      title: "处理外部清单差异（0.1.13）",
      purpose:
        "查看缺少、额外、大小或校验值不同的完整文件列表，并安全完成处理。",
      steps: [
        "在拍摄项目的素材卷明细中点击红色“清单差异”状态。",
        "使用 Finder 按钮打开素材卷、外部清单或具体差异文件的位置。",
        "同时出现缺少和额外文件时，先按弹窗顺序补回缺失文件；成功修复会保留，剩余额外文件会原地刷新显示。",
        "带“(1)”的缺失路径与相似额外路径会显示为疑似同名冲突，并分别列出清单大小与当前大小；名称相似不会自动视为同一文件。",
        "出现“缺少”时，可选择同一素材卡根目录、对应素材子目录或其上级目录；Kocpy 只接受唯一完整的路径映射。",
        "映射确定后先检查容量并验证全部源文件，再统一暂存、校验、提交，最后执行整卷重校验。",
        "若缺失文件确实由操作人主动剔除，可填写原因、勾选风险确认并输入“修改 MHL”，经审计修订生效清单。",
        "只出现“额外”时，先检查文件内容；0 字节文件建议移出素材卷。有效文件可直接在弹窗建立当前完整哈希基线，再明确确认保留。",
        "手工处理文件后也可以点击“重新完整核对”，只有整卷清单通过后才会恢复绿色状态。",
      ],
      tips: [
        "存在多种完整映射，或健康副本有任一文件大小、校验值不符时，修复会在写入前停止。",
        "确认额外文件不会修改原 MHL；原始差异和确认时间都会保留在审计记录中。",
        "修订前原始 MHL 会按 SHA-256 备份到 Kocpy 审计历史；绿色状态会明确显示排除数量，点击可定位原始清单。",
        "大小不同或校验值不同不能通过清单修订跳过。",
      ],
      page: "projects",
    },
    {
      id: "checklist",
      icon: CheckCheck,
      title: "开工、收工与交接",
      purpose: "使用标准检查表、制作人员记录和签名完成每日交接。",
      steps: [
        "在项目设置中维护制作人员与角色。",
        "开工前确认项目、日期、摄影机和独立目的地。",
        "收工时确认副本、报告和安全推出。",
        "在归档维护中签署检查表并记录交接说明。",
      ],
      tips: ["签名是本地制作审计记录，不等同于法律数字签名。"],
      page: "maintenance",
    },
    {
      id: "nas",
      icon: HardDrive,
      title: "NAS 与网络目标",
      purpose: "保存已挂载 SMB/NFS 目录并进行容量、延迟与读写检查。",
      steps: [
        "先在 Finder 挂载网络共享。",
        "在归档维护保存 NAS 预设。",
        "执行检查并确认写入速度达到项目要求。",
        "备份时可点击选择或直接拖入网络目录。",
      ],
      tips: [
        "网络中断目标可重试，本地健康目标继续完成。",
        "不要在未验证的公共网络暴露局域网索引。",
      ],
      page: "maintenance",
    },
    {
      id: "team",
      icon: Share2,
      title: "多工作站与局域网索引",
      purpose: "交换配置包、合并记录，或临时共享只读项目索引。",
      steps: [
        "导出工作站包并通过可信方式传到另一台 Mac；包只包含 Kocpy 元数据。",
        "在另一台 Mac 先只读预检来源、包摘要、新增、重复、字段、证据与删除冲突。",
        "所有冲突默认保留本机；逐项选择需要采用的外部值，填写操作人并确认后提交。",
        "双方反向导出、导入并重启核对；合并审计默认折叠，可按需展开检查。",
        "仅在受信任局域网启用带随机令牌的只读索引。",
      ],
      tips: [
        "配置包不会复制、移动、删除或重新校验原始素材。",
        "工作站合并审计不等于另一台 Mac 的素材副本当前健康。",
        "局域网索引只读；令牌应通过可信渠道传递。",
      ],
      page: "maintenance",
    },
    {
      id: "database",
      icon: Database,
      title: "大型项目与数据恢复",
      purpose: "数据库索引支持分页搜索，JSON 兼容副本用于迁移与恢复。",
      steps: [
        "升级时自动从旧记录重建索引。",
        "素材库按批次加载并使用增量搜索。",
        "定期导出本地数据备份。",
        "索引损坏时从备份恢复或安全重建。",
      ],
      tips: [
        "不要手动修改应用数据目录。",
        "历史项目可冷归档，原素材不会被删除。",
        "冷归档只有在写入、落盘并重新解压校验成功后，才会从热索引移除任务。",
      ],
      page: "maintenance",
    },
  ];
  return (
    <div className="help-center">
      <section className="panel help-start">
        <div>
          <span className="mini-label">
            <BookOpen size={13} /> KOCPY {APP_VERSION} · QUICK START
          </span>
          <h2>软件使用说明</h2>
          <p>
            推荐流程：创建项目 → 连接素材卡 → 选择不同物理盘 → 拷贝 → 独立校验 →
            收工检查 → 导出报告 → 安全推出。
          </p>
        </div>
        <Button kind="primary" onClick={openBackup}>
          <Plus size={15} />
          开始第一份备份
        </Button>
      </section>
      <section className="help-safety">
        <ShieldCheck size={20} />
        <div>
          <strong>三条安全原则</strong>
          <p>
            源素材只读处理 · 每个副本独立回读校验 · 至少保存到两块不同物理磁盘
          </p>
        </div>
      </section>
      <section className="help-release-note">
        <RefreshCw size={20} />
        <div>
          <strong>0.1.32：克制、可访问的界面动效</strong>
          <p>
            页面、弹窗、提示、按钮、主题、开关与真实进度采用统一的短时动效；动画不会控制任务状态、文件写入、确认或审计。
          </p>
          <p>
            不增加动画运行库，不推算或伪造进度。系统开启“减少动态效果”时，所有动画与过渡完整关闭。
          </p>
          <strong>0.1.31：稳定工作站身份与可审计合并</strong>
          <p>
            每台 Mac 使用跨重启稳定的随机身份。工作站包记录唯一导出
            ID、权威工作区依据、交换摘要和删除墓碑；身份或恢复记录损坏时停止合并，不猜测重建。
          </p>
          <p>
            导入先显示只读预检；同
            ID、内容、项目字段、追加证据和删除冲突默认保留本机。只有逐项选择外部值、填写操作人并确认后才提交，没有批量覆盖。
          </p>
          <p>
            提交前再次核对包、本机记录和模板摘要，中断后可按审计恢复且不重复合并。配置包只交换元数据，不复制、删除、移动或重新校验素材。
          </p>
        </div>
      </section>
      <SearchBox
        value={helpQuery}
        onChange={setHelpQuery}
        placeholder="搜索模块、操作步骤或注意事项…"
      />
      <div className="help-grid">
        {guides
          .filter((guide) =>
            [guide.title, guide.purpose, ...guide.steps, ...guide.tips]
              .join(" ")
              .toLowerCase()
              .includes(helpQuery.toLowerCase()),
          )
          .map(({ id, icon: Icon, title, purpose, steps, tips, page }) => (
            <details className="help-module" key={id} data-page={page || id}>
              <summary>
                <span>
                  <Icon size={19} />
                </span>
                <div>
                  <strong>{title}</strong>
                  <small>{purpose}</small>
                </div>
                <ChevronRight size={15} />
              </summary>
              <div className="help-body">
                <h4>操作步骤</h4>
                <ol>
                  {steps.map((step, index) => (
                    <li key={step}>
                      <b>{index + 1}</b>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                <h4>注意事项</h4>
                <ul>
                  {tips.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
                {page && (
                  <Button kind="subtle" onClick={() => go(page)}>
                    打开{title}
                    <ArrowRight size={13} />
                  </Button>
                )}
              </div>
            </details>
          ))}
      </div>
    </div>
  );
}

function MaintenancePage({
  initialProjectId,
  tasks,
  projects,
  refreshProjects,
  notify,
}: {
  initialProjectId?: string;
  tasks: BackupTask[];
  projects: ProjectConfig[];
  refreshProjects: () => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [health, setHealth] = useState<import("./api").ArchiveHealthRecord[]>(
      [],
    ),
    [templates, setTemplates] = useState<import("./api").ProjectTemplate[]>([]),
    [archiveRuns, setArchiveRuns] = useState<
      import("./api").ArchiveVerificationRun[]
    >([]),
    [archiveReminders, setArchiveReminders] = useState<
      import("./api").ArchiveReminder[]
    >([]),
    [workstationIdentity, setWorkstationIdentity] = useState<
      import("./api").WorkstationIdentity | null
    >(null),
    [workstationAudits, setWorkstationAudits] = useState<
      import("./api").WorkstationImportAuditRecord[]
    >([]),
    [archiveOperator, setArchiveOperator] = useState(""),
    [reminderDays, setReminderDays] = useState<Record<string, number>>({}),
    [busy, setBusy] = useState<string | null>(null),
    [handoff, setHandoff] = useState(""),
    [handoffOperator, setHandoffOperator] = useState(""),
    [handoffExceptions, setHandoffExceptions] = useState(""),
    [handoffScope, setHandoffScope] = useState<"day" | "project">("project"),
    [handoffDate, setHandoffDate] = useState(today()),
    [handoffProject, setHandoffProject] = useState(
      projects.find((p) => p.id === initialProjectId)?.id ||
        projects[0]?.id ||
        "",
    ),
    [outcome, setOutcome] = useState(""),
    [workspaceImport, setWorkspaceImport] =
      useState<WorkspaceImportPreview | null>(null),
    [templateEditor, setTemplateEditor] = useState<Partial<
      import("./api").ProjectTemplate
    > | null>(null),
    [templateApply, setTemplateApply] = useState<{
      template: import("./api").ProjectTemplate;
      projectId: string;
      projectName: string;
      changes: Array<{
        field: string;
        label: string;
        before: string;
        after: string;
      }>;
    } | null>(null);
  const reload = useCallback(async () => {
    const [records, values, runs, reminders, identity, audits] =
      await Promise.all([
        api.getArchiveHealth(),
        api.getProjectTemplates(),
        api.getArchiveRuns(),
        api.getArchiveReminders(),
        api.getWorkstationIdentity(),
        api.getWorkstationImportAudits(),
      ]);
    setHealth(records);
    setTemplates(values);
    setArchiveRuns(runs);
    setArchiveReminders(reminders);
    setWorkstationIdentity(identity);
    setWorkstationAudits(audits);
    setReminderDays((current) => ({
      ...Object.fromEntries(
        reminders.map((item) => [item.projectId, item.intervalDays]),
      ),
      ...current,
    }));
  }, []);
  useEffect(() => {
    void reload().catch((error) => notify(String(error), true));
  }, [reload, notify]);
  useEffect(() => {
    void api.getSettings().then((settings) => {
      if (settings.operator) setArchiveOperator(settings.operator);
    });
  }, []);
  const run = async (
    key: string,
    action: () => Promise<unknown>,
    success: string,
  ) => {
    setBusy(key);
    try {
      const result = await action();
      if (!didComplete(result)) {
        setOutcome("已取消");
        return false;
      }
      await reload();
      await refreshProjects();
      const data = result as any;
      const details =
        data?.taskCount !== undefined
          ? ` · ${data.healthyTasks}/${data.taskCount} 个任务健康`
          : data?.repaired !== undefined
            ? ` · 修复 ${data.repaired} 个文件，保留原损坏文件 ${data.preservedDamagedOriginals} 个`
            : "";
      if (success) {
        setOutcome(success + details);
        notify(success + details);
      }
      return true;
    } catch (error) {
      setOutcome(readableOperationError(error));
      notify(readableOperationError(error), true);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const lastHealth = (projectId: string) =>
    [...health].reverse().find((record) => record.projectId === projectId);
  const visibleTemplates = templates.filter((template) => !template.hidden),
    hiddenSystemTemplates = templates.filter(
      (template) => template.hidden && template.id.startsWith("builtin-"),
    );
  return (
    <div className="maintenance-center">
      {workspaceImport && (
        <WorkstationImportDialog
          preview={workspaceImport}
          defaultOperator={archiveOperator}
          onClose={() => setWorkspaceImport(null)}
          onApplied={(result) => {
            const message = result.repeated
              ? `该配置包与决定已处理，返回既有审计：修订 ${result.importedRevision}`
              : `合并完成：新增 ${result.tasksAdded} 个任务、${result.projectsAdded} 个项目；保留 ${result.unresolvedConflicts || 0} 项本机冲突`;
            setWorkspaceImport(null);
            setOutcome(message);
            notify(message);
            void reload();
            void refreshProjects();
          }}
        />
      )}
      {outcome && (
        <p className="notice" role="status">
          {outcome}
        </p>
      )}
      <section className="panel diagnostics-hero">
        <div>
          <span className="mini-label">
            <span className="live-dot" /> ARCHIVE LIFECYCLE
          </span>
          <h2>素材归档生命周期</h2>
          <p>
            复校验项目副本、保存健康变化、复用项目模板，并在不同工作站之间合并任务记录。
          </p>
          {workstationIdentity && (
            <div className="workstation-local-identity">
              <strong>{workstationIdentity.displayName}</strong>
              <span className="mono">{workstationIdentity.id}</span>
              <small>本机稳定工作站 ID；主机改名不会改变此身份</small>
            </div>
          )}
        </div>
        <div className="row">
          <Button
            kind="subtle"
            onClick={() =>
              void run(
                "backup",
                async () => {
                  const file = await api.backupWorkspaceData();
                  if (file) await api.reveal(file);
                  return file;
                },
                "本地数据备份已导出",
              )
            }
          >
            <Archive size={14} />
            备份本地数据
          </Button>
          <Button
            kind="subtle"
            onClick={() =>
              void run(
                "restore-cold",
                async () => {
                  const result = await api.restoreColdArchive();
                  if (result) notify(`冷归档已恢复：${result.tasks} 个任务`);
                  return result;
                },
                "",
              )
            }
          >
            <Upload size={14} />
            恢复冷归档
          </Button>
          <Button
            kind="subtle"
            onClick={() =>
              void run(
                "export",
                async () => {
                  const file = await api.exportWorkspace();
                  if (file) await api.reveal(file);
                  return file;
                },
                "工作站配置包已导出",
              )
            }
          >
            <Share2 size={14} />
            导出工作站包
          </Button>
          <Button
            kind="primary"
            disabled={busy === "import"}
            onClick={() => {
              setBusy("import");
              void api
                .importWorkspace()
                .then((preview) => {
                  if (preview) setWorkspaceImport(preview);
                  else setOutcome("已取消");
                })
                .catch((error) => {
                  const message = readableOperationError(error);
                  setOutcome(message);
                  notify(message, true);
                })
                .finally(() => setBusy(null));
            }}
          >
            <Download size={14} />
            预检工作站包
          </Button>
        </div>
      </section>
      {workstationAudits.length > 0 && (
        <details className="panel workstation-audit-panel">
          <summary>
            <span>
              <ShieldCheck size={17} /> 工作站合并审计
            </span>
            <small>{workstationAudits.length} 条记录 · 点击展开</small>
          </summary>
          <div className="workstation-audit-list">
            {workstationAudits.slice(0, 20).map((audit) => (
              <article key={audit.id}>
                <div>
                  <strong>{audit.sourceWorkstationName}</strong>
                  <span>
                    {new Date(audit.importedAt).toLocaleString()} · 操作人{" "}
                    {audit.operator}
                  </span>
                </div>
                <div>
                  <span>
                    新增 {audit.result.projectsAdded} 个项目 /{" "}
                    {audit.result.tasksAdded} 个任务
                  </span>
                  <span>
                    保留本机冲突 {audit.result.unresolvedConflicts || 0} 项 ·
                    修订 {audit.importedRevision}
                  </span>
                  <span>
                    采用外部{" "}
                    {
                      audit.decisions.filter(
                        (item) => item.decision === "incoming",
                      ).length
                    }{" "}
                    项
                  </span>
                </div>
                <small className="mono">包 SHA-256 {audit.packageSha256}</small>
              </article>
            ))}
          </div>
        </details>
      )}
      <section className="panel">
        <div className="section-title">
          <div>
            <h2>
              <ShieldCheck size={18} />
              项目归档健康
            </h2>
            <span className="muted small">
              复校验会重新读取每个副本，不依赖历史完成状态
            </span>
          </div>
          <label className="archive-operator-field">
            <span>本次维护操作人</span>
            <input
              value={archiveOperator}
              maxLength={120}
              placeholder="填写实际操作人"
              onChange={(event) => setArchiveOperator(event.target.value)}
            />
          </label>
        </div>
        <div className="maintenance-projects">
          {projects.map((project) => {
            const related = tasks.filter(
                (task) => task.projectId === project.id,
              ),
              last = lastHealth(project.id),
              lastRun = [...archiveRuns]
                .reverse()
                .find((item) => item.projectId === project.id),
              reminder = archiveReminders.find(
                (item) => item.projectId === project.id,
              ),
              failed = related.flatMap((task) =>
                task.destinations
                  .filter((destination) => !destination.verified)
                  .map((destination) => ({ task, destination })),
              );
            return (
              <div className="maintenance-project" key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <small>
                    {last
                      ? `${new Date(last.checkedAt).toLocaleString("zh-CN")} · ${last.healthyTasks}/${last.taskCount} 个任务健康`
                      : "尚未执行长期复校验"}
                  </small>
                  {lastRun && (
                    <small>
                      证据 {lastRun.resultDigest.slice(0, 12)}… · 操作人{" "}
                      {lastRun.operator} ·{" "}
                      {lastRun.status === "completed"
                        ? "通过"
                        : lastRun.status === "partial"
                          ? "部分完成"
                          : "未通过"}
                    </small>
                  )}
                  <small>
                    {reminder
                      ? `${reminder.enabled ? "提醒已启用" : "提醒已暂停"} · ${new Date(reminder.nextAt).toLocaleDateString("zh-CN")} 待核验${reminder.lastTargetState === "offline" ? " · 上次目标离线" : reminder.lastTargetState === "identity-unknown" ? " · 上次身份未知" : ""}`
                      : "尚未设置周期复校验提醒"}
                  </small>
                </div>
                <div className="row">
                  <Button
                    kind="subtle"
                    disabled={
                      busy !== null ||
                      !related.length ||
                      !archiveOperator.trim()
                    }
                    onClick={() =>
                      void run(
                        `verify-${project.id}`,
                        () =>
                          api.verifyProjectArchive(project.id, archiveOperator),
                        `${project.name} 长期复校验完成`,
                      )
                    }
                  >
                    {busy === `verify-${project.id}` ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    复校验项目
                  </Button>
                  <Button
                    kind="subtle"
                    disabled={busy !== null}
                    onClick={() =>
                      setTemplateEditor(projectTemplateDraft(project))
                    }
                  >
                    <Copy size={14} />
                    保存为模板
                  </Button>
                  <Button
                    kind="subtle"
                    disabled={busy !== null || !related.length}
                    onClick={() =>
                      void run(
                        `cold-${project.id}`,
                        async () => {
                          const file = await api.coldArchiveProject(project.id);
                          if (file) await api.reveal(file);
                          return file;
                        },
                        "项目已冷归档并从热数据中卸载",
                      )
                    }
                  >
                    <Archive size={14} />
                    冷归档
                  </Button>
                  {failed.map(({ task, destination }) => (
                    <Button
                      key={destination.id}
                      kind="danger"
                      disabled={busy !== null || !archiveOperator.trim()}
                      onClick={() =>
                        void run(
                          `repair-${destination.id}`,
                          () =>
                            api.repairArchiveCopy(
                              task.id,
                              destination.id,
                              archiveOperator,
                            ),
                          "副本已从健康来源修复；原损坏文件已保留",
                        )
                      }
                    >
                      <ShieldCheck size={14} />
                      修复 {task.name} ·{" "}
                      {leaf(destination.resolvedPath || destination.path)}
                    </Button>
                  ))}
                  <input
                    className="archive-reminder-days"
                    type="number"
                    min={1}
                    max={3650}
                    aria-label={`${project.name} 复校验间隔天数`}
                    value={reminderDays[project.id] || 180}
                    onChange={(event) =>
                      setReminderDays((current) => ({
                        ...current,
                        [project.id]: Math.max(
                          1,
                          Math.min(3650, Number(event.target.value) || 180),
                        ),
                      }))
                    }
                  />
                  <Button
                    kind="subtle"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(
                        `reminder-${project.id}`,
                        () =>
                          api.saveArchiveReminder({
                            id: reminder?.id || "",
                            projectId: project.id,
                            intervalDays: reminderDays[project.id] || 180,
                            nextAt: reminder?.lastSuccessfulVerificationAt
                              ? reminder.lastSuccessfulVerificationAt +
                                (reminderDays[project.id] || 180) * 86_400_000
                              : reminder?.nextAt ||
                                Date.now() +
                                  (reminderDays[project.id] || 180) *
                                    86_400_000,
                            enabled: reminder ? !reminder.enabled : true,
                            lastNotifiedAt: reminder?.lastNotifiedAt,
                            lastSuccessfulVerificationAt:
                              reminder?.lastSuccessfulVerificationAt,
                            lastRunId: reminder?.lastRunId,
                            lastRisk: reminder?.lastRisk,
                            lastTargetState: reminder?.lastTargetState,
                          }),
                        reminder?.enabled ? "归档提醒已暂停" : "归档提醒已启用",
                      )
                    }
                  >
                    <Bell size={14} />
                    {reminder?.enabled ? "暂停提醒" : "启用提醒"}
                  </Button>
                  <Button
                    kind="subtle"
                    disabled={busy !== null || !lastRun}
                    onClick={() =>
                      void run(
                        `archive-report-${project.id}`,
                        async () => {
                          const file = await api.exportArchiveChanges(
                            project.id,
                          );
                          if (file) await api.reveal(file);
                          return file;
                        },
                        "归档变化报告已导出",
                      )
                    }
                  >
                    <FileDown size={14} />
                    导出归档证据
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <section className="panel">
        <div className="section-title">
          <div>
            <h2>
              <FolderKanban size={18} />
              项目模板与交接
            </h2>
            <span className="muted small">
              模板保存设备、副本标准、命名规则与完成动作；交接记录随工作站包合并
            </span>
          </div>
          <div className="row template-toolbar">
            <span className="muted small">
              {visibleTemplates.length} 个可用模板
            </span>
            {hiddenSystemTemplates.length > 0 && (
              <Button
                kind="subtle"
                disabled={busy !== null}
                onClick={() =>
                  void run(
                    "restore-templates",
                    async () => {
                      for (const template of hiddenSystemTemplates)
                        await api.hideProjectTemplate(template.id, false);
                    },
                    "系统模板已恢复",
                  )
                }
              >
                恢复系统模板
              </Button>
            )}
            <Button
              kind="subtle"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "import-templates",
                  () => api.importProjectTemplates(),
                  "项目模板已导入",
                )
              }
            >
              <Upload size={14} />
              导入
            </Button>
            <Button
              kind="subtle"
              disabled={busy !== null}
              onClick={() =>
                void run(
                  "export-templates",
                  async () => {
                    const file = await api.exportProjectTemplates();
                    if (file) await api.reveal(file);
                    return file;
                  },
                  "自定义模板已导出",
                )
              }
            >
              <Download size={14} />
              导出
            </Button>
            <Button
              kind="primary"
              disabled={busy !== null}
              onClick={() => setTemplateEditor({})}
            >
              <Plus size={14} />
              新建模板
            </Button>
          </div>
        </div>
        {visibleTemplates.length ? (
          <div className="template-list">
            {visibleTemplates.map((template) => {
              const system = template.id.startsWith("builtin-");
              return (
                <div className="template-card" key={template.id}>
                  <div className="template-card-copy">
                    <div className="row">
                      <strong>{template.name}</strong>
                      <span
                        className={`template-kind ${system ? "system" : "custom"}`}
                      >
                        {system ? "系统模板" : "自定义"} · v
                        {template.revision || 1}
                      </span>
                    </div>
                    <p>{template.description || "未填写模板说明"}</p>
                    <div className="template-facts">
                      <span>{template.devices.join(" / ")}</span>
                      <span>{template.requiredCopies} 份物理副本</span>
                      <span>{template.checklists?.length || 0} 项检查表</span>
                      <span>
                        {template.completionActions
                          .map(
                            (item) =>
                              ({
                                report: "报告",
                                delivery: "交付",
                                proxy: "代理",
                                eject: "推出",
                              })[item],
                          )
                          .join(" / ") || "无完成建议"}
                      </span>
                    </div>
                    <code>{template.namingRule}</code>
                  </div>
                  <div className="template-card-actions">
                    <select
                      id={`template-project-${template.id}`}
                      aria-label="应用模板到项目"
                      defaultValue={
                        projects.find(
                          (project) => project.id === initialProjectId,
                        )?.id ||
                        projects[0]?.id ||
                        ""
                      }
                    >
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      kind="subtle"
                      disabled={!projects.length || busy !== null}
                      onClick={() => {
                        const select = document.getElementById(
                            `template-project-${template.id}`,
                          ) as HTMLSelectElement,
                          project = projects.find(
                            (item) => item.id === select.value,
                          );
                        if (!project) return;
                        setBusy(`preview-${template.id}`);
                        void api
                          .previewProjectTemplate(template.id, project.id)
                          .then((preview) =>
                            setTemplateApply({
                              template,
                              projectId: project.id,
                              projectName: project.name,
                              changes: preview.changes,
                            }),
                          )
                          .catch((error) =>
                            notify(String(error).replace(/^Error: /, ""), true),
                          )
                          .finally(() => setBusy(null));
                      }}
                    >
                      应用并预览
                    </Button>
                    <Button
                      kind="icon"
                      title={system ? "复制为自定义模板" : "编辑模板"}
                      onClick={() =>
                        setTemplateEditor(
                          system
                            ? {
                                ...template,
                                id: undefined,
                                name: `${template.name} 副本`,
                                kind: "custom",
                                hidden: false,
                              }
                            : template,
                        )
                      }
                    >
                      {system ? (
                        <Copy size={14} />
                      ) : (
                        <SlidersHorizontal size={14} />
                      )}
                    </Button>
                    {system ? (
                      <Button
                        kind="icon"
                        title="隐藏系统模板"
                        onClick={() =>
                          void run(
                            `hide-${template.id}`,
                            () => api.hideProjectTemplate(template.id, true),
                            "系统模板已隐藏",
                          )
                        }
                      >
                        <Eye size={14} />
                      </Button>
                    ) : (
                      <Button
                        kind="icon danger"
                        title="删除自定义模板"
                        onClick={() =>
                          void run(
                            `delete-${template.id}`,
                            () => api.deleteProjectTemplate(template.id),
                            "模板已删除",
                          )
                        }
                      >
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={Copy}
            title="还没有项目模板"
            detail="在上方项目中选择“保存为模板”，即可复用设备和收工标准。"
          />
        )}
        <div className="handoff-row">
          <label>
            交接人
            <input
              aria-label="交接操作人"
              placeholder="实际交接人姓名"
              value={handoffOperator}
              onChange={(event) => setHandoffOperator(event.target.value)}
            />
          </label>
          <label>
            交接项目
            <select
              id="handoff-project"
              aria-label="交接项目"
              value={handoffProject}
              onChange={(event) => setHandoffProject(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="handoff-note">
            交接说明
            <input
              value={handoff}
              onChange={(event) => setHandoff(event.target.value)}
              placeholder="记录磁盘交接、异常说明或下一班注意事项"
            />
          </label>
          <label>
            交接范围
            <select
              aria-label="交接范围"
              value={handoffScope}
              onChange={(event) =>
                setHandoffScope(event.target.value as "day" | "project")
              }
            >
              <option value="project">整个项目</option>
              <option value="day">单个拍摄日</option>
            </select>
          </label>
          {handoffScope === "day" && (
            <label>
              拍摄日期
              <input
                type="date"
                aria-label="交接拍摄日期"
                value={handoffDate}
                onChange={(event) => setHandoffDate(event.target.value)}
              />
            </label>
          )}
          <label className="handoff-exceptions">
            已知例外（可选，每行一项）
            <textarea
              aria-label="交接已知例外"
              value={handoffExceptions}
              onChange={(event) => setHandoffExceptions(event.target.value)}
              placeholder="例如：B 机位第二副本离线，夜班重新连接后复校验"
              rows={3}
            />
          </label>
          <Button
            kind="primary"
            disabled={
              busy !== null ||
              !projects.some((project) => project.id === handoffProject) ||
              !handoff.trim() ||
              !handoffOperator.trim()
            }
            onClick={() => {
              const select = document.getElementById(
                "handoff-project",
              ) as HTMLSelectElement;
              void run(
                "handoff",
                () =>
                  api.addProjectHandoff(
                    handoffProject,
                    handoffOperator.trim(),
                    handoff,
                    {
                      scope: handoffScope,
                      shootingDate:
                        handoffScope === "day" ? handoffDate : undefined,
                      exceptions: handoffExceptions.split(/\r?\n/),
                    },
                  ),
                "交接记录已保存",
              ).then((ok) => {
                if (ok) {
                  setHandoff("");
                  setHandoffExceptions("");
                }
              });
            }}
          >
            <Check size={14} />
            保存交接
          </Button>
        </div>
        {(() => {
          const project = projects.find((item) => item.id === handoffProject),
            records = [...(project?.handoffNotes || [])].reverse().slice(0, 5);
          return records.length ? (
            <div className="handoff-evidence-list">
              <strong>最近交接证据</strong>
              {records.map((record) => (
                <div key={record.id}>
                  <span>
                    {new Date(record.at).toLocaleString()} · {record.operator} ·
                    {record.scope === "day"
                      ? ` 拍摄日 ${record.shootingDate}`
                      : " 整个项目"}
                  </span>
                  <p>{record.note}</p>
                  {Boolean(record.exceptions?.length) && (
                    <ul>
                      {record.exceptions!.map((exception) => (
                        <li key={exception}>{exception}</li>
                      ))}
                    </ul>
                  )}
                  {record.closeoutEvidence && (
                    <small>
                      规则 {record.ruleSnapshotId ? "已快照" : "旧记录未快照"} ·
                      素材卷 {record.closeoutEvidence.compliantVolumes}/
                      {record.closeoutEvidence.logicalVolumes} 达标 · 待处理{" "}
                      {record.closeoutEvidence.pendingCells} · 待确认{" "}
                      {record.closeoutEvidence.unconfirmedCells}
                    </small>
                  )}
                </div>
              ))}
            </div>
          ) : null;
        })()}
      </section>
      <LifecycleControls
        initialProjectId={initialProjectId}
        projects={projects}
        tasks={tasks}
        notify={notify}
        refreshProjects={refreshProjects}
      />
      {templateEditor && (
        <TemplateEditor
          initial={templateEditor}
          onClose={() => setTemplateEditor(null)}
          onSaved={(values) => {
            setTemplates(values);
            notify("项目模板已保存");
          }}
        />
      )}
      {templateApply && (
        <TemplateApplyDialog
          template={templateApply.template}
          projectId={templateApply.projectId}
          projectName={templateApply.projectName}
          changes={templateApply.changes}
          onClose={() => setTemplateApply(null)}
          onApplied={() => {
            void refreshProjects();
            notify("模板已按所选配置应用到项目");
          }}
        />
      )}
    </div>
  );
}

function DiagnosticsPage({
  tasks,
  volumes,
  notify,
}: {
  tasks: BackupTask[];
  volumes: Volume[];
  notify: (message: string, error?: boolean) => void;
}) {
  const [running, setRunning] = useState<string | null>(null),
    [results, setResults] = useState<
      Record<string, { writeBps: number; readBps: number; durationMs: number }>
    >({}),
    [validations, setValidations] = useState<
      import("./api").ReliabilityValidationRecord[]
    >([]);
  useEffect(() => {
    void api
      .getReliabilityValidations()
      .then(setValidations)
      .catch(() => {});
  }, []);
  const attention = tasks.filter(
    (task) =>
      ["failed", "paused", "cancelled"].includes(task.status) ||
      task.destinations.some(
        (destination) =>
          !destination.verified &&
          task.status !== "running" &&
          task.status !== "verifying",
      ),
  );
  const run = async (volume: Volume) => {
    setRunning(volume.path);
    try {
      const result = await api.runBenchmark(volume.path, 64);
      if (!result) return;
      setResults((current) => ({ ...current, [volume.path]: result }));
      notify(`${volume.name} 性能预检完成，临时测试文件已清理`);
    } catch (error) {
      notify(String(error).replace(/^Error: /, ""), true);
    } finally {
      setRunning(null);
    }
  };
  const validate = async (volume: Volume) => {
    setRunning(`validate:${volume.path}`);
    try {
      const result = await api.validateReliabilityVolume(volume.path);
      if (!result) return;
      setValidations(await api.getReliabilityValidations());
      notify(
        `${volume.name} 有限读写测试通过：${result.smallFiles} 个小文件与 ${bytes(result.largeFileBytes)} 大文件`,
      );
    } catch (error) {
      setValidations(
        await api.getReliabilityValidations().catch(() => validations),
      );
      notify(String(error).replace(/^Error: /, ""), true);
    } finally {
      setRunning(null);
    }
  };
  return (
    <div className="diagnostics-center">
      <section className="panel diagnostics-hero">
        <div>
          <span className="mini-label">
            <span className={attention.length ? "alert-dot" : "live-dot"} />{" "}
            RELIABILITY STATUS
          </span>
          <h2>
            {attention.length
              ? `${attention.length} 个任务需要诊断`
              : "当前状态正常"}
          </h2>
          <p>
            {attention.length
              ? "按任务检查素材源、目的地、断点与校验状态。"
              : "没有暂停、中断、失败或未完成校验的任务。"}{" "}
            诊断导出不会包含素材内容与完整私人路径。
          </p>
        </div>
        <Button
          kind="primary"
          onClick={() =>
            void api
              .exportDiagnostics()
              .then((file) => file && notify(`诊断包已保存：${file}`))
              .catch((error) => notify(String(error), true))
          }
        >
          <PackageSearch size={15} />
          导出脱敏诊断包
        </Button>
      </section>
      <section className="panel">
        <div className="section-title">
          <div>
            <h2>
              <Gauge size={18} />
              磁盘性能预检
            </h2>
            <span className="muted small">
              写入并回读 64 MiB 临时文件；测试结束自动清理，备份运行时禁止执行
            </span>
          </div>
        </div>
        <div className="benchmark-grid">
          {volumes.map((volume) => {
            const result = results[volume.path];
            const validation = [...validations]
              .reverse()
              .find((item) => item.path === volume.path);
            return (
              <div className="benchmark-card" key={volume.path}>
                <div>
                  <HardDrive size={18} />
                  <span>
                    <strong>{volume.name}</strong>
                    <small>
                      {volume.isNetwork
                        ? `${volume.protocol || "网络"} · ${volume.latencyMs || 0} ms`
                        : volume.deviceType === "source"
                          ? "素材设备"
                          : "本地存储"}
                    </small>
                  </span>
                </div>
                {result ? (
                  <div className="benchmark-result">
                    <span>
                      <b>{bytes(result.writeBps)}/s</b>写入
                    </span>
                    <span>
                      <b>{bytes(result.readBps)}/s</b>回读
                    </span>
                  </div>
                ) : (
                  <p>
                    {bytes(volume.free)} 可用 ·{" "}
                    {volume.writable === false ? "只读" : "可写"}
                  </p>
                )}
                <Button
                  kind="subtle"
                  disabled={
                    running !== null ||
                    volume.writable === false ||
                    volume.deviceType === "source"
                  }
                  onClick={() => void run(volume)}
                >
                  {running === volume.path ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  开始预检
                </Button>
                <Button
                  kind="subtle"
                  disabled={
                    running !== null ||
                    volume.writable === false ||
                    volume.deviceType === "source"
                  }
                  onClick={() => void validate(volume)}
                >
                  {running === `validate:${volume.path}` ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  有限读写测试
                </Button>
                {validation && (
                  <small
                    className={
                      validation.status === "passed" ? "green-text" : "red-text"
                    }
                  >
                    {validation.fileSystem} ·{" "}
                    {validation.status === "passed"
                      ? "64 MiB / 1000 小文件通过（非全面可靠性认证）"
                      : validation.error}
                  </small>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="panel">
        <div className="section-title">
          <div>
            <h2>
              <RefreshCw size={18} />
              恢复诊断
            </h2>
            <span className="muted small">
              按当前任务状态明确区分素材源、目的地、断点和校验问题
            </span>
          </div>
        </div>
        {attention.length ? (
          <div className="diagnostic-list">
            {attention.slice(0, 50).map((task) => {
              const offline = task.destinations.filter(
                  (destination) => destination.available === false,
                ).length,
                failed = task.destinations.filter(
                  (destination) => destination.error,
                ).length,
                unverified = task.destinations.filter(
                  (destination) => !destination.verified,
                ).length;
              const summary =
                task.status === "paused"
                  ? "可从当前检查点继续"
                  : /素材源|source/i.test(task.errorMessage || "")
                    ? "素材源未连接或身份变化"
                    : offline
                      ? `${offline} 个目的地未连接`
                      : failed
                        ? `${failed} 个目的地写入或校验失败`
                        : task.transferredBytes > 0 &&
                            task.transferredBytes < task.totalBytes
                          ? "存在可复用的安全断点"
                          : `${unverified} 个副本尚未通过校验`;
              return (
                <div key={task.id}>
                  <AlertTriangle size={17} />
                  <span>
                    <strong>{task.name}</strong>
                    <small>{summary}</small>
                  </span>
                  <TaskBadge task={task} />
                </div>
              );
            })}
          </div>
        ) : (
          <Empty
            icon={CheckCheck}
            title="诊断状态正常"
            detail="没有暂停、中断、失败或未完成校验的任务。"
          />
        )}
      </section>
    </div>
  );
}

export function ProxyQueue({
  jobs,
  act,
  refresh,
}: {
  jobs: ProxyJob[];
  act: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [sourceTask, setSourceTask] = useState("");
  const [queueLimit, setQueueLimit] = useState(100);
  const rows = [...jobs]
    .filter((job) => !sourceTask || job.sourceTaskId === sourceTask)
    .reverse();
  const exportIds = rows
    .filter((job) => job.status === "completed")
    .map((job) => job.id);
  return (
    <section className="panel proxy-queue-panel">
      <div className="proxy-scope-toolbar">
        <label>
          队列与交付范围
          <select
            aria-describedby="proxy-scope-help"
            value={sourceTask}
            onChange={(e) => {
              setSourceTask(e.target.value);
              setQueueLimit(100);
            }}
          >
            <option value="">全部已记录素材</option>
            {[
              ...new Map(
                jobs
                  .filter((job) => job.sourceTaskId)
                  .map((job) => [job.sourceTaskId, job.name]),
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name} · {id?.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <p id="proxy-scope-help" className="muted small">
          以下导出仅包含当前范围已完成的 {exportIds.length}{" "}
          个代理；排队中不代表完成。
        </p>
      </div>
      <div className="section-title">
        <div>
          <h2>
            代理处理队列{" "}
            <span>
              {
                jobs.filter((j) =>
                  ["pending", "running", "paused"].includes(j.status),
                ).length
              }
            </span>
          </h2>
          <span className="muted small">
            队列按顺序处理，保留原素材关联并检查帧率、时间码与音轨
          </span>
        </div>
      </div>
      <div className="notice proxy-compatibility-notice">
        <ShieldCheck size={16} />
        <span>
          DaVinci Resolve：固定 H.264／ProRes Proxy 合成样本实际导入验证。
          Premiere CSV 与 Final Cut XML 当前只完成格式检查，未在本机 NLE
          实际导入；导出文件会保留这一兼容性说明。
        </span>
      </div>
      <div
        className="proxy-delivery-actions"
        role="group"
        aria-label="交付导出"
      >
        <Button
          kind="primary"
          onClick={() =>
            void act(async () => {
              const folder = await api.exportProxyPackage(exportIds);
              if (folder) await api.reveal(folder);
              return folder;
            }, "完整交付目录与检查报告已生成")
          }
        >
          <PackageCheck size={14} />
          生成交付目录
        </Button>
        <Button
          kind="subtle"
          title="固定 H.264／ProRes Proxy 样本已在本机 DaVinci Resolve 实际导入"
          onClick={() =>
            void act(async () => {
              const file = await api.exportProxyDelivery("resolve", exportIds);
              if (file) await api.reveal(file);
              return file;
            }, "Resolve 交付清单已导出")
          }
        >
          Resolve CSV
        </Button>
        <Button
          kind="subtle"
          onClick={() =>
            void act(async () => {
              const file = await api.exportProxyDelivery("premiere", exportIds);
              if (file) await api.reveal(file);
              return file;
            }, "Premiere 交付清单已导出")
          }
        >
          Premiere CSV · 未实测
        </Button>
        <Button
          kind="subtle"
          title="当前机器未安装 Final Cut Pro：FCPXML 结构已检查，未做本机实际导入"
          onClick={() =>
            void act(async () => {
              const file = await api.exportProxyDelivery("fcpxml", exportIds);
              if (file) await api.reveal(file);
              return file;
            }, "Final Cut XML 已导出")
          }
        >
          Final Cut XML · 未实测
        </Button>
      </div>
      {rows.length > queueLimit && (
        <Button onClick={() => setQueueLimit((value) => value + 100)}>
          加载更多代理任务
        </Button>
      )}
      {rows.length ? (
        <div className="proxy-job-list">
          {rows.slice(0, queueLimit).map((job) => (
            <div className="proxy-job" key={job.id}>
              <span
                className={`file-icon ${job.status === "completed" ? "green" : ""}`}
              >
                <Clapperboard size={19} />
              </span>
              <div className="proxy-job-main">
                <div className="row between">
                  <strong>{job.name}</strong>
                  <span className={`badge ${job.status}`}>
                    {
                      (
                        {
                          pending: "等待处理",
                          running: "正在转码",
                          paused: "已暂停",
                          completed: "已完成",
                          failed: "失败",
                          cancelled: "已取消",
                        } as Record<string, string>
                      )[job.status]
                    }
                  </span>
                </div>
                {job.status === "paused" &&
                  job.pauseReason === "backup-priority" && (
                    <p className="amber-text small">
                      备份优先：已安全暂停，备份队列空闲后自动继续
                    </p>
                  )}
                <p>
                  {job.preset === "editorial"
                    ? "剪辑代理"
                    : job.preset === "offline"
                      ? "离线剪辑"
                      : "通用审片"}{" "}
                  · {job.format.toUpperCase()} · {job.resolution}
                  {job.timecode ? ` · TC ${job.timecode}` : ""}
                </p>
                <p className="small">
                  阶段：
                  {{
                    queued: "等待源证据核验",
                    "validating-source": "正在完整核验已校验源",
                    transcoding: "正在转码",
                    "validating-output": "正在建立输出哈希证据",
                    ready: "输出证据已建立",
                  }[job.stage || "queued"] || "历史任务 · 阶段未知"}
                </p>
                <div className="progress-track">
                  <i style={{ width: `${job.progress}%` }} />
                </div>
                <p className="mono">
                  源：{job.input}
                  <br />
                  目的地：{job.outputPath || job.outputDir}
                </p>
                {job.sourceEvidence && (
                  <p className="mono small">
                    源证据：{job.sourceEvidence.hashAlgorithm.toUpperCase()} ·{" "}
                    {job.sourceEvidence.checksum}
                  </p>
                )}
                {job.outputEvidence && (
                  <p className="mono small">
                    输出证据：SHA-256 · {job.outputEvidence.sha256}
                  </p>
                )}
                {!!job.dependsOn?.length && (
                  <p className="small">等待依赖：{job.dependsOn.join("、")}</p>
                )}
                {job.validation && (
                  <small
                    className={
                      job.validation.notes.length ? "amber-text" : "green-text"
                    }
                  >
                    {job.validation.notes.length
                      ? job.validation.notes.join(" · ")
                      : "时长、帧率、时间码、音轨、旋转与色彩检查未发现异常"}
                  </small>
                )}
                {job.error && <small className="red-text">{job.error}</small>}
              </div>
              <div className="row">
                {job.status === "running" && (
                  <Button
                    kind="subtle"
                    onClick={() =>
                      void act(async () => {
                        await api.pauseProxy(job.id);
                        await refresh();
                      }, "代理任务正在安全暂停")
                    }
                  >
                    <Pause size={12} />
                    暂停
                  </Button>
                )}
                {job.status === "paused" && (
                  <Button
                    kind="primary"
                    onClick={() =>
                      void act(async () => {
                        await api.resumeProxy(job.id);
                        await refresh();
                      }, "代理任务已继续")
                    }
                  >
                    <Play size={12} />
                    继续
                  </Button>
                )}
                {["running", "pending", "paused"].includes(job.status) ? (
                  <Button
                    kind="danger"
                    onClick={() =>
                      void act(async () => {
                        await api.cancelProxy(job.id);
                        await refresh();
                      }, "代理任务已取消")
                    }
                  >
                    <Square size={12} />
                    取消
                  </Button>
                ) : null}
                {["failed", "cancelled"].includes(job.status) && (
                  <Button
                    kind="subtle"
                    onClick={() =>
                      void act(async () => {
                        await api.retryProxy(job.id);
                        await refresh();
                      }, "已重新加入队列")
                    }
                  >
                    <RefreshCw size={13} />
                    重试
                  </Button>
                )}
                {job.outputPath && (
                  <Button
                    kind="icon"
                    title="在 Finder 中显示"
                    onClick={() => void api.reveal(job.outputPath!)}
                  >
                    <FolderOpen size={15} />
                  </Button>
                )}
                {!["running", "pending", "paused"].includes(job.status) && (
                  <Button
                    kind="icon"
                    title="删除队列记录"
                    onClick={() =>
                      void act(async () => {
                        await api.deleteProxy(job.id);
                        await refresh();
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          icon={Activity}
          title="代理队列为空"
          detail="在素材库中选择已校验的视频并加入队列，可连续处理多个代理任务。"
        />
      )}
    </section>
  );
}
function SettingsPage({
  settings,
  onSave,
  notify,
  updateInfo,
  setUpdateInfo,
}: {
  settings: Settings;
  onSave: (s: Settings) => Promise<void>;
  notify: (m: string, e?: boolean) => void;
  updateInfo: UpdateInfo | null;
  setUpdateInfo: (info: UpdateInfo | null) => void;
}) {
  const savedTheme = useRef(settings.theme);
  savedTheme.current = settings.theme;
  useEffect(
    () => () => {
      document.documentElement.dataset.theme = savedTheme.current;
      void api.previewTheme(savedTheme.current).catch(() => {});
    },
    [],
  );
  const [draft, setDraft] = useState(settings),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = draft.theme;
    void api.previewTheme(draft.theme).catch(() => {});
  }, [draft.theme]);
  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } catch (e) {
      notify(String(e), true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="settings-layout">
      <section className="panel settings-panel">
        <div className="section-title">
          <h2>
            <ShieldCheck size={18} />
            备份默认值
          </h2>
          <span className="muted small">新任务会使用这些设置</span>
        </div>
        <div className="setting-row">
          <div>
            <h3>操作人</h3>
            <p>报告使用实际操作人姓名；交接与签署仍需明确确认。</p>
          </div>
          <input
            aria-label="默认操作人"
            value={draft.operator}
            onChange={(event) =>
              setDraft({ ...draft, operator: event.target.value })
            }
          />
        </div>
        <p className="muted small">
          {JSON.stringify(draft) === JSON.stringify(settings)
            ? "设置已保存"
            : "有未保存的设置；离开页面将放弃本次修改与主题预览"}
        </p>
        <div className="setting-row">
          <div>
            <h3>完整性校验</h3>
            <p>逐文件回读所有目的地，完整比对哈希值。</p>
          </div>
          <span className="protected">
            <ShieldCheck size={14} />
            始终开启
          </span>
        </div>
        <div className="setting-row">
          <div>
            <h3>哈希算法</h3>
            <p>SHA-256 默认推荐，兼顾可追溯性与兼容性。</p>
          </div>
          <select
            aria-label="默认哈希算法"
            value={draft.defaultHash}
            onChange={(e) =>
              setDraft({
                ...draft,
                defaultHash: e.target.value as Settings["defaultHash"],
              })
            }
          >
            <option value="sha256">SHA-256</option>
            <option value="md5">MD5</option>
            <option value="sha1">SHA-1</option>
          </select>
        </div>
        <div className="setting-row">
          <div>
            <h3>同名文件处理</h3>
            <p>跳过时仍会验证内容；不同内容不会被覆盖。</p>
          </div>
          <select
            aria-label="默认同名处理策略"
            value={draft.defaultDuplicateStrategy}
            onChange={(e) =>
              setDraft({
                ...draft,
                defaultDuplicateStrategy: e.target.value as "skip" | "suffix",
              })
            }
          >
            <option value="skip">校验后跳过</option>
            <option value="suffix">创建副本</option>
          </select>
        </div>
        <div className="setting-row">
          <div>
            <h3>包含隐藏文件</h3>
            <p>系统索引与 .DS_Store 始终排除，保留拍摄相关文件。</p>
          </div>
          <button
            role="switch"
            aria-label="包含隐藏文件"
            aria-checked={draft.includeHidden}
            className={`switch ${draft.includeHidden ? "on" : ""}`}
            onClick={() =>
              setDraft({ ...draft, includeHidden: !draft.includeHidden })
            }
          >
            <i />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <h3>软件更新</h3>
            <p>
              {updateInfo
                ? updateInfo.available
                  ? `发现 Kocpy ${updateInfo.latest} · ${updateInfo.archLabel} 安装包。`
                  : `当前 ${updateInfo.current} 已是最新版本 · ${updateInfo.archLabel} Mac。`
                : "启动后自动检查官方 GitHub Release，也可以手动检查。"}
            </p>
            {updateInfo?.available && !updateInfo.downloadUrl && (
              <small className="red-text">
                当前版本尚未上传与你的 Mac 架构匹配的安装包。
              </small>
            )}
          </div>
          <div className="row">
            <Button
              kind="subtle"
              onClick={() =>
                void api
                  .checkUpdates()
                  .then(setUpdateInfo)
                  .catch((e) => notify(String(e), true))
              }
            >
              <RefreshCw size={14} />
              检查更新
            </Button>
            {updateInfo?.available && (
              <Button
                kind="primary"
                onClick={() =>
                  void api.openUpdate(
                    updateInfo.downloadUrl || updateInfo.releaseUrl,
                  )
                }
              >
                <Download size={14} />
                升级到 {updateInfo.latest}
              </Button>
            )}
            {updateInfo && (
              <Button
                kind="icon"
                title="查看 GitHub Release"
                onClick={() => void api.openUpdate(updateInfo.releaseUrl)}
              >
                <ExternalLink size={14} />
              </Button>
            )}
          </div>
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="section-title">
          <h2>
            <SlidersHorizontal size={18} />
            工作空间
          </h2>
        </div>
        <div className="setting-row">
          <div>
            <h3>界面外观</h3>
            <p>为现场与工作室选择舒适的亮度。</p>
          </div>
          <div className="segmented" role="radiogroup" aria-label="界面主题">
            <button
              role="radio"
              aria-checked={draft.theme === "dark"}
              className={draft.theme === "dark" ? "selected" : ""}
              onClick={() => setDraft({ ...draft, theme: "dark" })}
            >
              <Moon size={14} />
              深色
            </button>
            <button
              role="radio"
              aria-checked={draft.theme === "light"}
              className={draft.theme === "light" ? "selected" : ""}
              onClick={() => setDraft({ ...draft, theme: "light" })}
            >
              <Sun size={14} />
              浅色
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <h3>数据与隐私</h3>
            <p>无需账号，任务与项目保存在本机；只在你指定时镜像报告。</p>
          </div>
          <span className="small muted">Kocpy 本地工作空间</span>
        </div>
        <div className="setting-row">
          <div>
            <h3>云端报告镜像</h3>
            <p>
              {draft.reportSyncPath ||
                "可选择 iCloud Drive、Dropbox 或其他同步盘文件夹；只镜像导出的报告与清单，不复制素材。"}
            </p>
          </div>
          <div className="row">
            <Button
              kind="subtle"
              onClick={() =>
                void api
                  .selectDirectory()
                  .then(
                    (folder) =>
                      folder && setDraft({ ...draft, reportSyncPath: folder }),
                  )
              }
            >
              <FolderOpen size={14} />
              选择文件夹
            </Button>
            {draft.reportSyncPath && (
              <Button
                kind="icon"
                title="关闭报告镜像"
                onClick={() => setDraft({ ...draft, reportSyncPath: "" })}
              >
                <X size={14} />
              </Button>
            )}
          </div>
        </div>
        <div className="setting-row">
          <div>
            <h3>缩略图与波形缓存</h3>
            <p>超过限制时优先清理最久未使用的缓存，不会删除素材。</p>
          </div>
          <select
            aria-label="缩略图与波形缓存上限"
            value={draft.thumbnailCacheGiB}
            onChange={(e) =>
              setDraft({ ...draft, thumbnailCacheGiB: Number(e.target.value) })
            }
          >
            {[1, 2, 5, 10, 20].map((value) => (
              <option key={value} value={value}>
                {value} GiB
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <h3>通知声音</h3>
            <p>备份完成和归档复校验到期时使用系统通知声音。</p>
          </div>
          <button
            role="switch"
            aria-label="通知声音"
            aria-checked={draft.notificationSound}
            className={`switch ${draft.notificationSound ? "on" : ""}`}
            onClick={() =>
              setDraft({
                ...draft,
                notificationSound: !draft.notificationSound,
              })
            }
          >
            <i />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <h3>快捷操作</h3>
            <p>⌘ N 新建备份 · / 搜索 · Esc 关闭面板</p>
          </div>
          <Command size={18} />
        </div>
      </section>
      <div className="row justify-end">
        <Button kind="primary" disabled={saving} onClick={() => void save()}>
          {saving ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Check size={16} />
          )}
          保存设置
        </Button>
      </div>
      <div className="about-panel">
        <img src="./icon.png" alt="Kocpy 图标" />
        <div>
          <h3>
            Kocpy <span>{APP_VERSION}</span>
          </h3>
          <p>从现场接卡、项目归档到交付报告，为每一份创作保留可靠副本。</p>
          <small>本地优先 · 独立校验 · 项目全周期记录 · @sexyfeifan</small>
        </div>
      </div>
    </div>
  );
}
function ProxyDialog({
  file,
  busy,
  setBusy,
  onClose,
  notify,
}: {
  file: { name: string; path: string; paths?: string[] };
  busy: boolean;
  setBusy: (b: boolean) => void;
  onClose: () => void;
  notify: (s: string, e?: boolean) => void;
}) {
  const [out, setOut] = useState(""),
    [format, setFormat] = useState<"h264" | "prores">("h264"),
    [res, setRes] = useState("1080p"),
    [bitrate, setBitrate] = useState(0),
    [container, setContainer] = useState<"mp4" | "mov" | "mkv">("mp4"),
    [preset, setPreset] = useState<"review" | "editorial" | "offline">(
      "review",
    ),
    [namingTemplate, setNamingTemplate] = useState("{name}_proxy_{resolution}"),
    [savedPresets, setSavedPresets] = useState<SavedProxyPreset[]>([]),
    [savedPresetId, setSavedPresetId] = useState(""),
    [presetName, setPresetName] = useState(""),
    [result, setResult] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    void api
      .getProxyPresets()
      .then(setSavedPresets)
      .catch((e) => setError(String(e)));
  }, []);
  function applySaved(id: string) {
    setSavedPresetId(id);
    const value = savedPresets.find((item) => item.id === id);
    if (!value) return;
    setPresetName(value.name);
    setPreset(
      value.purpose || (value.format === "prores" ? "editorial" : "review"),
    );
    setFormat(value.format);
    setRes(value.resolution);
    setBitrate(value.bitrateMbps || 0);
    setContainer(value.format === "prores" ? "mov" : value.container);
    setNamingTemplate(value.namingTemplate);
  }
  async function savePreset() {
    try {
      setSavedPresets(
        await api.saveProxyPreset({
          id: savedPresetId || undefined,
          name: presetName,
          format,
          resolution: res,
          bitrateMbps: bitrate || undefined,
          container,
          namingTemplate,
          purpose: preset,
        }),
      );
      setSavedPresetId("");
      setPresetName("");
      notify("代理预设已保存");
    } catch (e) {
      setError(String(e));
    }
  }
  async function run() {
    setBusy(true);
    setError("");
    try {
      await api.enqueueProxy(file.paths || [file.path], out, format, res, {
        preset,
        namingTemplate,
        bitrateMbps: bitrate || undefined,
        container,
      });
      setResult("已加入代理队列");
      notify("视频已加入代理队列");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="form-modal"
        role="dialog"
        aria-modal="true"
        aria-label="生成代理"
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">PROXY WORKFLOW</span>
            <h2>生成剪辑代理</h2>
          </div>
          <Button
            kind="icon"
            title="关闭代理面板"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </Button>
        </div>
        <div className="form-body">
          <div className="notice">
            <ShieldCheck size={17} />
            从已校验的备份副本读取，原始素材保持不变。
          </div>
          <div className="form-grid">
            <label>
              我的代理预设
              <select
                value={savedPresetId}
                onChange={(e) => applySaved(e.target.value)}
              >
                <option value="">选择已保存预设</option>
                {savedPresets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              预设名称
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="例如：剪辑部 1080p"
              />
            </label>
          </div>
          <div className="inline-actions">
            <Button
              disabled={!presetName.trim()}
              onClick={() => void savePreset()}
            >
              {savedPresetId ? "更新预设" : "保存为预设"}
            </Button>
            {savedPresetId && (
              <Button
                kind="danger"
                onClick={() =>
                  void api.deleteProxyPreset(savedPresetId).then((items) => {
                    setSavedPresets(items);
                    setSavedPresetId("");
                    setPresetName("");
                  })
                }
              >
                删除预设
              </Button>
            )}
          </div>
          <label>
            视频文件
            <input readOnly value={file.name} />
          </label>
          <div className="form-grid">
            <label>
              代理预设
              <select
                value={preset}
                onChange={(e) => {
                  const value = e.target.value as
                    "review" | "editorial" | "offline";
                  setPreset(value);
                  if (value === "editorial") {
                    setFormat("prores");
                    setRes("1080p");
                    setContainer("mov");
                  } else if (value === "offline") {
                    setFormat("h264");
                    setRes("720p");
                    setContainer("mp4");
                  } else {
                    setFormat("h264");
                    setRes("1080p");
                    setContainer("mp4");
                  }
                }}
                disabled={busy}
              >
                <option value="review">通用审片 · H.264 1080p</option>
                <option value="editorial">剪辑代理 · ProRes 1080p</option>
                <option value="offline">离线剪辑 · H.264 720p</option>
              </select>
            </label>
            <label>
              编码格式
              <select
                value={format}
                onChange={(e) => {
                  const value = e.target.value as "h264" | "prores";
                  setFormat(value);
                  if (value === "prores") setContainer("mov");
                }}
                disabled={busy}
              >
                <option value="h264">H.264 · 通用预览</option>
                <option value="prores">ProRes Proxy · 剪辑</option>
              </select>
            </label>
            <label>
              常用输出尺寸
              <select
                value={
                  ["1080p", "720p", "2160p"].includes(res) ? res : "custom"
                }
                onChange={(e) =>
                  setRes(
                    e.target.value === "custom" ? "1920x1080" : e.target.value,
                  )
                }
                disabled={busy}
              >
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
                <option value="2160p">2160p</option>
                <option value="custom">自定义宽×高</option>
              </select>
            </label>
            <label>
              视频码率（Mbps）
              <input
                type="number"
                min="0"
                max="500"
                value={bitrate}
                onChange={(e) =>
                  setBitrate(Math.max(0, Number(e.target.value)))
                }
              />
              <small>0 使用质量模式</small>
            </label>
            <label>
              封装格式
              <select
                value={container}
                onChange={(e) =>
                  setContainer(e.target.value as typeof container)
                }
                disabled={busy || format === "prores"}
              >
                {format === "prores" ? (
                  <option value="mov">MOV · ProRes 必需</option>
                ) : (
                  <>
                    <option value="mp4">MP4</option>
                    <option value="mov">MOV</option>
                    <option value="mkv">MKV</option>
                  </>
                )}
              </select>
            </label>
          </div>
          {!["1080p", "720p", "2160p"].includes(res) && (
            <label>
              自定义分辨率
              <input
                value={res}
                onChange={(e) => setRes(e.target.value)}
                placeholder="例如 1920x1080"
              />
              <small>使用明确的宽×高；不会用未知比例补成 16:9。</small>
            </label>
          )}
          <div className="notice">
            <Info size={16} />
            <span>
              {preset === "editorial"
                ? "剪辑代理：ProRes Proxy / MOV，文件通常较大，适合剪辑交换。"
                : preset === "offline"
                  ? "离线剪辑：H.264 720p，体积较小，适合轻量剪辑与传输。"
                  : "通用审片：H.264 1080p，兼顾画面检查与交付体积。"}
              参数会在入队时冻结；转码前重新完整核验已校验源，完成后建立输出
              SHA-256 证据。
            </span>
          </div>
          <label>
            输出命名规则
            <input
              value={namingTemplate}
              onChange={(e) => setNamingTemplate(e.target.value)}
              disabled={busy}
              placeholder="{name}_proxy_{resolution}"
            />
            <span className="muted small">
              支持 {"{name}"}、{"{resolution}"}、{"{format}"}
              ；始终追加唯一短码且不覆盖已有文件。
            </span>
          </label>
          <label>
            输出文件夹
            <div className="path-input">
              <input
                aria-label="代理输出文件夹"
                value={out}
                onChange={(e) => setOut(e.target.value)}
                disabled={busy}
                placeholder="选择独立的代理目录"
              />
              <Button
                kind="icon"
                title="选择代理输出目录"
                disabled={busy}
                onClick={() =>
                  void api
                    .selectDirectory()
                    .then((p) => p && setOut(p))
                    .catch((e) => setError(String(e)))
                }
              >
                <FolderOpen size={17} />
              </Button>
            </div>
          </label>
          <p className="muted small">
            保持原始宽高比、不放大小尺寸素材。生成期间请保持应用运行。编解码支持取决于内置
            FFmpeg，不保证专有 RAW 格式。
          </p>
          {result && (
            <div className="success-box" role="status">
              <CheckCircle2 size={17} />
              {result}，可在「代理队列」查看进度、取消或重试。
            </div>
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span className="small muted">唯一文件名 · 不覆盖已有文件</span>
          <Button
            kind="primary"
            disabled={busy || !out || !!result}
            onClick={() => void run()}
          >
            <Play size={15} />
            {busy ? "提交中…" : result ? "已加入队列" : "加入代理队列"}
          </Button>
        </div>
      </section>
    </div>
  );
}
