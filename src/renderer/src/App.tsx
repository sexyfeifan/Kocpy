import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
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
  ExternalLink,
  Trash2,
  ChevronsUp,
  Activity,
  Pause,
  Github,
  Gauge,
  PackageSearch,
  Database,
  Share2,
  CircleHelp,
  BookOpen,
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
  type UpdateInfo,
  type TransferPerformance,
} from "./api";
import { Composer } from "./Composer";
import { ProjectEditor } from "./ProjectEditor";
import { projectCellStatus, projectCloseoutSummary, verifiedPhysicalCopyCount } from "../../main/project-closeout";

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
  ["transfers", "传输队列", ArrowLeftRight],
  ["recovery", "恢复中心", RefreshCw],
  ["projects", "拍摄项目", FolderKanban],
  ["library", "素材库", Film],
  ["processing", "代理队列", Activity],
  ["reports", "报告中心", FileCheck2],
  ["storage", "存储设备", HardDrive],
  ["diagnostics", "诊断中心", Gauge],
  ["maintenance", "归档维护", Database],
  ["help", "使用说明", CircleHelp],
];
const projectDates = (project: ProjectConfig, tasks: BackupTask[]) => {
  const result: string[] = [], start = project.shootingDateStart, end = project.shootingDateEnd || start;
  if (start && end) for (let cursor = new Date(`${start}T12:00:00`), finish = new Date(`${end}T12:00:00`); cursor <= finish && result.length < 1000; cursor.setDate(cursor.getDate() + 1)) result.push(cursor.toLocaleDateString("sv-SE"));
  return [...new Set([...result, ...tasks.map((task) => task.shootingDate).filter(Boolean) as string[]])].sort();
};
const defaults: Settings = {
  defaultHash: "sha256",
  defaultDuplicateStrategy: "skip",
  includeHidden: true,
  operator: "",
  theme: "dark",
  reportSyncPath: "",
};
const duration = (seconds = 0) => {
  const value = Math.max(0, Math.round(seconds));
  const h = Math.floor(value / 3600), m = Math.floor((value % 3600) / 60), s = value % 60;
  return `${h ? `${h}时` : ""}${h || m ? `${String(m).padStart(h ? 2 : 1, "0")}分` : ""}${String(s).padStart(h || m ? 2 : 1, "0")}秒`;
};
export function Button({
  children,
  onClick,
  kind = "",
  disabled = false,
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: string;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`btn ${kind}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
export function Empty({
  icon: Icon = FolderOpen,
  title,
  detail,
  action,
}: {
  icon?: typeof FolderOpen;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={28} strokeWidth={1.3} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {statusText[status] || status}
    </span>
  );
}
function SpeedSparkline({ values, color = "var(--purple)" }: { values: number[]; color?: string }) {
  const max = Math.max(1, ...values), points = (values.length ? values : [0]).map((value, index, all) => `${(index / Math.max(1, all.length - 1)) * 100},${28 - (value / max) * 24}`).join(" ");
  return <svg className="speed-sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="最近 30 秒速度曲线"><polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/></svg>;
}
const performanceText = (performance?: TransferPerformance) => performance?.samples ? `平均 ${bytes(performance.average)}/s · P95 ${bytes(performance.p95)}/s · 峰值 ${bytes(performance.peak)}/s${performance.stalls ? ` · ${performance.stalls} 次停顿` : ""}` : "样本不足";
export function App() {
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
    [detail, setDetail] = useState<string | null>(null),
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
    } | null>(null),
    [proxy, setProxy] = useState<{ path: string; name: string; paths?: string[] } | null>(null),
    [proxyBusy, setProxyBusy] = useState(false),
    [completion, setCompletion] = useState<BackupTask | null>(null),
    [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);
  const act = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      try {
        await fn();
        if (success) notify(success);
      } catch (e) {
        notify(String(e).replace(/^Error: /, ""), true);
      }
    },
    [notify],
  );
  const refresh = useCallback(async () => setTasks(await api.getTasks()), []);
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
    void api.checkUpdates().then((info) => { if (!stopped) setUpdateInfo(info); }).catch(() => {});
    return () => {
      stopped = true;
      unsub();
      unsubProxy();
      unsubSettled();
      clearInterval(interval);
    };
  }, [notify, refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "n") {
        e.preventDefault();
        setComposer({});
      }
      if (e.key === "Escape") {
        if (document.querySelector('[role="dialog"][aria-busy="true"]')) return;
        if (!proxyBusy) setProxy(null);
        setComposer(null);
        setEditor(null);
        setDetail(null);
        setConfirm(null);
      }
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>(".search input")?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [proxyBusy]);
  const go = (p: Page) => {
    document.querySelector(".page-content")?.scrollTo({ top: 0 });
    setPage(p);
    setQuery("");
    setFilter("all");
  };
  const running = tasks.filter(active),
    finished = tasks.filter((t) => t.status === "completed"),
    current = tasks.find((t) => ["running", "paused", "verifying"].includes(t.status));
  const filtered = tasks.filter(
    (t) =>
      (t.name + " " + t.sourcePath)
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "active" && active(t)) ||
        t.status === filter),
  );
  const selected = tasks.find((t) => t.id === detail);
  const exportReport = (id: string, format: "pdf" | "json" | "mhl" | "ascmhl") =>
    act(async () => {
      const result = await api.exportReport(id, format);
      if (result) notify(`报告已保存：${result}`);
    });
  const taskRows = (rows: BackupTask[], compact = false) => (
    <div className="task-list">
      {rows.map((t) => (
        <button className="task-row" key={t.id} onClick={() => setDetail(t.id)}>
          <span
            className={`file-icon ${t.status === "completed" ? "green" : ""}`}
          >
            {t.status === "completed" ? (
              <CheckCheck size={20} />
            ) : (
              <MemoryStick size={20} />
            )}
          </span>
          <div className="task-name">
            <strong>{t.name}</strong>
            <span>
              {leaf(t.sourcePath)} <span className="dot-sep">·</span>{" "}
              {t.destinations.length} 个目的地{" "}
              <span className="dot-sep">·</span>{" "}
              {date(t.startedAt || t.createdAt)}
            </span>
          </div>
          {!compact && (
            <span className="task-size">
              {bytes(t.totalBytes)}
              <small>{t.totalFiles} 个文件</small>
            </span>
          )}
          <Badge status={t.status} />
          <ChevronRight size={16} />
        </button>
      ))}
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
      {v.isNetwork && <div className="row between small"><span>{v.protocol?.toUpperCase()} · {v.writable ? "可写" : "只读"}</span><span>{v.latencyMs} ms 响应</span></div>}
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
  const saveProject = async (p: ProjectConfig, createMissing = true) => {
    setProjects(await api.saveProject(p, createMissing));
    setComposer((current) => current ? { ...current, project: p } : current);
    setEditor(null);
    notify("项目已保存");
  };
  const checkForUpdates = async () => {
    try {
      const info = await api.checkUpdates();
      setUpdateInfo(info);
      if (info.available) await api.openUpdate(info.downloadUrl || info.releaseUrl);
      else notify(`Kocpy ${info.current} 已是最新版本`);
    } catch (error) {
      notify(String(error).replace(/^Error: /, ""), true);
    }
  };
  const projectDetail = projects.find((project) => project.id === projectDetailId);
  const projectDetailTasks = tasks.filter((task) => task.projectId === projectDetailId);
  const projectDetailCloseout = projectDetail ? projectCloseoutSummary(projectDetail, projectDetailTasks, projectDates(projectDetail, projectDetailTasks)) : null;
  const activeProjectCloseouts = projects.filter((project) => project.status !== "archived").map((project) => { const related = tasks.filter((task) => task.projectId === project.id), dates = projectDates(project, related); return { project, related, summary: projectCloseoutSummary(project, related, dates) }; });
  const recoveryTasks = tasks.filter((task) => ["failed", "cancelled", "paused", "pending"].includes(task.status) || task.destinations.some((destination) => destination.available === false || Boolean(destination.error) || (!destination.verified && task.status !== "running" && task.status !== "verifying")));
  const updateProjectSchedule = async (project: ProjectConfig, dateValue: string, device?: string) => {
    const next = { ...project, restDays: [...(project.restDays || [])], unusedDevicesByDate: { ...(project.unusedDevicesByDate || {}) } };
    if (!device) next.restDays = next.restDays.includes(dateValue) ? next.restDays.filter((date) => date !== dateValue) : [...next.restDays, dateValue];
    else { const values = [...(next.unusedDevicesByDate[dateValue] || [])]; next.unusedDevicesByDate[dateValue] = values.includes(device) ? values.filter((value) => value !== device) : [...values, device]; }
    setProjects(await api.saveProject(next, false));
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag" />
        <div className="brand">
          <img src="./icon.png" alt="Kocpy 图标" />
          <div>
            <strong>
              Kocpy<span>0.0.15</span>
            </strong>
            <small>素材工作台</small>
          </div>
        </div>
        <Button kind="primary new-button" onClick={() => setComposer({})}>
          <Plus size={17} />
          新建备份<span className="key-hint">⌘ N</span>
        </Button>
        <div className="nav-label">工作空间</div>
        <nav>
          {navigation.map(([id, label, Icon]) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "selected" : ""}`}
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
            onClick={() => go("settings")}
          >
            <Settings2 size={18} />
            <span>偏好设置</span>
            {updateInfo?.available && <b title={`发现 Kocpy ${updateInfo.latest}`}>1</b>}
          </button>
          <div className="sidebar-foot">
            <button className={`sidebar-update ${updateInfo?.available ? "available" : ""}`} title="检查 Kocpy 更新" onClick={() => void checkForUpdates()}>
              <RefreshCw size={13}/>
              <span>{updateInfo?.available ? `可升级 ${updateInfo.latest}` : "检查更新"}</span>
              <b>v0.0.15</b>
            </button>
            <div className="sidebar-author-links">
              <span><i className="live-dot"/><b>@sexyfeifan</b></span>
              <button title="作者 GitHub 主页" aria-label="打开作者 GitHub 主页" onClick={() => void api.openAuthor("https://github.com/sexyfeifan")}><Github size={15}/></button>
              <button title="作者小红书主页" aria-label="打开作者小红书主页" onClick={() => void api.openAuthor("https://www.xiaohongshu.com/user/profile/5d24d2ca000000001103fe97")}><img src="./xiaohongshu.png" alt=""/></button>
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
          </div>
        </header>
        <main className="page-content">
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
                    help: "使用说明",
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
                    help: "从第一次备份到项目归档，逐步了解每个模块。",
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
                        <span className="mini-label"><span className={tasks.some((t) => t.status === "failed") ? "alert-dot" : "live-dot"} /> DAILY OPERATIONS</span>
                        <h2>{current ? `${current.name} · ${statusText[current.status]}` : tasks.some((t) => t.status === "failed") ? `${tasks.filter((t) => t.status === "failed").length} 个任务需要处理` : "今日素材已妥善归档"}</h2>
                        <p>{current ? `${current.currentFile || "正在准备"} · ${Math.round(current.status === "verifying" ? current.verifyProgress || 0 : current.copyProgress || 0)}%` : `最近完成 ${finished.length} 次校验备份，连接下一张素材卡即可继续。`}</p>
                      </div>
                      <div className="operational-actions">
                        {tasks.some((t) => t.status === "failed") && <Button kind="danger" onClick={() => { go("transfers"); setFilter("failed"); }}><AlertTriangle size={15}/>查看异常</Button>}
                        <Button kind="primary" onClick={() => setComposer({})}><Plus size={15}/>继续拷卡</Button>
                      </div>
                    </section>
                  )}
                  {!tasks.length && <section className="welcome-panel">
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
                  </section>}
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
                      hint="所有目的地均通过校验"
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
                      value={String(projects.filter((p) => p.status !== "archived").length)}
                      hint="有序管理每一个拍摄计划"
                    />
                  </div>
                  {activeProjectCloseouts.length > 0 && <section className="panel daily-closeout"><div className="section-title"><div><h2><ShieldCheck size={18}/>项目收工检查</h2><span className="muted small">按日期、设备和物理独立副本核对，不把同盘目录重复计数</span></div><Button kind="subtle" onClick={() => go("projects")}>查看项目<ArrowRight size={14}/></Button></div><div className="daily-closeout-list">{activeProjectCloseouts.map(({project, summary}) => <button key={project.id} onClick={() => { setProjectDetailId(project.id); go("projects"); }}><FolderKanban size={17}/><span><strong>{project.name}</strong><small>{summary.pending.length ? `${summary.pending.length} 个日期/设备单元待完成` : "全部单元满足收工要求"}</small></span><b className={summary.pending.length ? "amber-text" : "green-text"}>{summary.complete} / {summary.total}</b><ChevronRight size={14}/></button>)}</div></section>}
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
                    <div className="tabs">
                      {[
                        ["all", "全部任务"],
                        ["active", "进行中"],
                        ["completed", "已完成"],
                        ["failed", "需处理"],
                        ["cancelled", "已取消"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
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
                    taskRows(filtered)
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
              {page === "recovery" && <section className="panel recovery-center">
                <div className="section-title"><div><h2><RefreshCw size={18}/>恢复中心</h2><span className="muted small">集中处理异常退出、断点文件、离线目的地与未完成校验</span></div><Button kind="subtle" onClick={() => void refresh()}><RefreshCw size={14}/>重新检测</Button></div>
                <div className="recovery-summary"><div><strong>{recoveryTasks.length}</strong><span>需要关注的任务</span></div><div><strong>{recoveryTasks.filter((task) => task.destinations.some((destination) => destination.available === false || destination.error)).length}</strong><span>失联或失败目标</span></div><div><strong>{recoveryTasks.filter((task) => task.transferredBytes > 0 && task.transferredBytes < task.totalBytes).length}</strong><span>可恢复断点任务</span></div></div>
                {recoveryTasks.length ? <div className="recovery-list">{recoveryTasks.map((task) => {
                  const failedTargets = task.destinations.filter((destination) => destination.available === false || destination.error || !destination.verified), successfulTargets = task.destinations.length - failedTargets.length;
                  const diagnosis = task.status === "paused" ? "任务仍在内存中暂停，可直接从当前位置继续" : successfulTargets > 0 && failedTargets.length > 0 ? `${successfulTargets} 个目标已安全保留；只处理 ${failedTargets.length} 个失败目标` : task.transferredBytes > 0 ? "将重新扫描素材源，验证并复用已有最终文件和安全断点" : "任务尚未写入，可以重新加入队列";
                  return <div key={task.id}><span className="file-icon"><RefreshCw size={18}/></span><div><strong>{task.name}</strong><p>{diagnosis}</p><small>{task.currentFile || task.errorMessage || task.sourcePath}</small></div><div className="row"><Badge status={task.status}/>{task.status === "paused" ? <Button kind="primary" onClick={() => void act(() => api.resumeTask(task.id), "任务已从当前检查点继续")}><Play size={13}/>从当前位置继续</Button> : successfulTargets > 0 && failedTargets.length > 0 ? <Button kind="primary" onClick={() => void act(() => api.retryFailedDestinations(task.id), "仅失败目标已加入重试队列")}><HardDrive size={13}/>仅重试失败目标</Button> : <Button kind="primary" onClick={() => void act(() => api.startTask(task.id), "已重新扫描并加入恢复队列")}><RefreshCw size={13}/>扫描并复用断点</Button>}{task.fileRecords.length > 0 && <Button kind="subtle" onClick={() => void act(() => api.reverifyTask(task.id), "复校验已完成")}><ShieldCheck size={13}/>重新校验全部副本</Button>}</div></div>;
                })}</div> : <Empty icon={CheckCheck} title="没有需要恢复的任务" detail="所有任务、目的地和校验记录均处于安全状态。"/>}
              </section>}
              {page === "projects" && (
                <>
                  <div className="list-toolbar plain">
                    <div className="tabs">
                      {[
                        ["all", "进行中"],
                        ["archived", "已归档"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
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
                            <div className="row"><Button kind="icon" title="检查项目目录结构" onClick={() => void act(async () => { const report = await api.inspectProjectStructure(p); const unavailable = report.destinations.filter((item) => item.error).length; notify(report.missingCount || report.conflictCount || unavailable ? `目录需要处理：缺少 ${report.missingCount} 个，冲突 ${report.conflictCount} 个，离线 ${unavailable} 个` : `项目目录完整：${report.expectedCount} 个目录均已就绪`, Boolean(report.conflictCount || unavailable)); })}><ShieldCheck size={16}/></Button><Button
                              kind="icon"
                              title="编辑项目"
                              onClick={() => setEditor(p)}
                            >
                              <SlidersHorizontal size={16} />
                            </Button></div>
                          </div>
                          <h2>{p.name}</h2>
                          <small className="mono muted">{p.projectFolderName}</small>
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
                                tasks.filter(
                                  (t) =>
                                    t.projectId === p.id &&
                                    t.status === "completed",
                                ).length
                              }{" "}
                              次备份完成
                            </span>
                          </div>
                          <div className="project-day-progress"><strong>项目素材进度</strong>{p.devices.map((device) => { const deviceTasks = tasks.filter((task) => task.projectId === p.id && task.devices.includes(device)); const verified = deviceTasks.filter((task) => task.status === "completed" && verifiedPhysicalCopyCount(task) >= (p.requiredCopies || 2)).length, size = deviceTasks.reduce((sum, task) => sum + task.totalBytes, 0); return <div key={device}><span>{device}</span><small className={verified && verified === deviceTasks.length ? "green-text" : "muted"}>{deviceTasks.length ? `${verified} / ${deviceTasks.length} 已校验 · ${bytes(size)}` : "尚未备份"}</small></div>; })}</div>
                          <div className="row between">
                            <div className="row"><Button kind="subtle" onClick={() => setProjectDetailId(projectDetailId === p.id ? null : p.id)}><Activity size={14}/>项目详情</Button><Button kind="subtle" onClick={() => setComposer({ project: p })}>使用此项目<ArrowRight size={14}/></Button></div>
                            <Button
                              kind="icon"
                              title={
                                p.status === "archived"
                                  ? "恢复项目"
                                  : "归档项目"
                              }
                              onClick={() =>
                                void act(
                                  async () =>
                                    setProjects(
                                      await api.saveProject({
                                        ...p,
                                        status:
                                          p.status === "archived"
                                            ? "active"
                                            : "archived",
                                      }, false),
                                    ),
                                  "项目状态已更新",
                                )
                              }
                            >
                              <Archive size={16} />
                            </Button>
                          </div>
                        </section>
                      ))}
                  </div>
                  {projectDetail && <section className="panel project-insights">
                    <div className="section-title"><div><h2><Activity size={18}/>{projectDetail.name} · 项目全周期</h2><span className="muted small">按拍摄日期与设备汇总素材卷、文件、容量和独立校验状态</span></div><div className="row"><Button kind="subtle" onClick={() => void act(async () => { const result = await api.exportProjectReport(projectDetail.id, "csv"); if (result) notify(`项目 CSV 已保存：${result}`); })}><Download size={14}/>CSV</Button><Button kind="subtle" onClick={() => void act(async () => { const result = await api.exportProjectReport(projectDetail.id, "json"); if (result) notify(`项目完整数据已保存：${result}`); })}>完整 JSON</Button><Button kind="subtle" onClick={() => void act(async () => { const result = await api.exportProjectReport(projectDetail.id, "pdf"); if (result) notify(`项目完整报告已保存：${result}`); })}><FileCheck2 size={14}/>项目 PDF</Button><Button kind="primary" onClick={() => void act(async () => { const result = await api.exportProjectReport(projectDetail.id, "bundle"); if (result) notify(`项目归档包已创建：${result}`); })}><Archive size={14}/>归档包</Button><Button kind="icon" title="关闭项目详情" onClick={() => setProjectDetailId(null)}><X size={15}/></Button></div></div>
                    <div className="project-total-cards"><div><strong>{projectDetailTasks.length}</strong><span>素材卷任务</span></div><div><strong>{projectDetailTasks.filter((task) => task.status === "completed" && verifiedPhysicalCopyCount(task) >= (projectDetail.requiredCopies || 2)).length} / {projectDetailTasks.length}</strong><span>达到副本要求</span></div><div><strong>{projectDetailTasks.reduce((sum, task) => sum + task.totalFiles, 0)}</strong><span>项目文件</span></div><div><strong>{bytes(projectDetailTasks.reduce((sum, task) => sum + task.totalBytes, 0))}</strong><span>项目总素材</span></div></div>
                    <div className="closeout-note"><ShieldCheck size={16}/><span>{projectDetailCloseout?.pending.length ? `仍有 ${projectDetailCloseout.pending.length} 个日期/设备单元待完成。` : "项目全部单元已满足要求。"} 收工标准：每个使用中的设备至少有 {projectDetail.requiredCopies || 2} 份物理独立校验副本。点击状态可标记休息日或当天未使用设备。</span></div>
                    <div className="project-matrix"><div className="project-matrix-head"><span>拍摄日期</span><span>设备 / 机位</span><span>素材卷</span><span>文件</span><span>素材量</span><span>收工检查</span></div>{projectDates(projectDetail, projectDetailTasks).flatMap((shootingDate) => projectDetail.devices.map((device) => { const cell = projectCellStatus(projectDetail, projectDetailTasks, shootingDate, device), rows = cell.rows; return <div className="project-matrix-row" key={`${shootingDate}-${device}`}><strong>{shootingDate.replace(/-/g, "")}</strong><span>{device}</span><span>{rows.length}</span><span>{rows.reduce((sum, task) => sum + task.totalFiles, 0)}</span><span>{bytes(rows.reduce((sum, task) => sum + task.totalBytes, 0))}</span><button className={cell.exempt || (rows.length && cell.safe === rows.length) ? "green-text" : rows.length ? "amber-text" : "muted"} onClick={() => void updateProjectSchedule(projectDetail, shootingDate, device)} title="切换当天未使用标记">{cell.label}</button></div>; }))}</div>
                    <div className="closeout-actions"><span>整日未拍摄时可直接标记：</span>{projectDates(projectDetail, projectDetailTasks).map((shootingDate) => <Button key={shootingDate} kind="subtle" onClick={() => void updateProjectSchedule(projectDetail, shootingDate)}>{projectDetail.restDays?.includes(shootingDate) ? <Check size={13}/> : <CalendarDays size={13}/>} {shootingDate.replace(/-/g, "")} {projectDetail.restDays?.includes(shootingDate) ? "休息日" : "标记休息"}</Button>)}</div>
                    {projectDetailTasks.length > 0 && <div className="project-task-breakdown"><strong>素材卷明细</strong>{[...projectDetailTasks].sort((a,b) => (a.shootingDate || "").localeCompare(b.shootingDate || "") || (a.startedAt || 0) - (b.startedAt || 0)).map((task) => <div key={task.id}><span>{task.shootingDate?.replace(/-/g, "") || "未标日期"} · {task.devices.join("/")}{task.cameraPosition ? ` · ${task.cameraPosition}` : ""}</span><b>{task.name}</b><small>{task.totalFiles} 个文件 · {bytes(task.totalBytes)}</small><Badge status={task.status}/></div>)}</div>}
                  </section>}
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
                  <div className="row justify-end"><Button kind="subtle" onClick={() => void act(async () => { const results = await api.ejectCompletedVolumes(); const success = results.filter((result) => result.ok).length; setVolumes(await api.listVolumes()); notify(`已安全推出 ${success} 个完成设备；${results.length - success} 个设备因安全检查未推出`, results.some((result) => !result.ok)); })}><Eject size={14}/>安全推出所有已完成设备</Button></div>
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
                      <div className="row"><Button kind="subtle" onClick={() => void act(async () => { const result = await api.exportResolveCsv(today()); if (result) notify(`Resolve 媒体池清单已保存：${result}`); })}><Clapperboard size={14}/>Resolve CSV</Button><Button kind="subtle" onClick={() => void act(async () => { const result = await api.exportDailyReport(today()); if (result) notify(`拍摄日汇总已保存：${result}`); })}><CalendarDays size={14}/>导出今日汇总</Button><SearchBox value={query} onChange={setQuery} placeholder="搜索报告…" /></div>
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
                              <Badge status={t.status} />
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
                              <Button kind="icon" title="导出通过 ASC XSD 结构验证的 ASC MHL v2 清单" onClick={() => void exportReport(t.id, "ascmhl")}><ShieldCheck size={16}/></Button>
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
              {page === "processing" && <ProxyQueue jobs={proxyJobs} act={act} refresh={async () => setProxyJobs(await api.getProxyJobs())} />}
              {page === "diagnostics" && <DiagnosticsPage tasks={tasks} volumes={volumes} notify={notify} />}
              {page === "maintenance" && <MaintenancePage tasks={tasks} projects={projects} refreshProjects={async () => setProjects(await api.getProjects())} notify={notify} />}
              {page === "help" && <HelpPage go={go} openBackup={() => setComposer({})} />}
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
              <i className="copy-fill"
                style={{
                  width: `${current.copyProgress || 0}%`,
                }}
              />
              <i className="verify-fill" style={{ width: `${current.verifyProgress || 0}%` }} />
            </div>
            <span>
              {current.status === "verifying" ? "校验" : "拷贝"} {Math.round(current.status === "verifying" ? current.verifyProgress || 0 : current.copyProgress || 0)}%
            </span>
            <ChevronRight size={15} />
          </button>
        )}
      </div>
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
                <Badge status={selected.status} />
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
                    {(selected.status === "verifying" ? selected.verifySpeedBps : selected.speedBps) ? bytes(selected.status === "verifying" ? selected.verifySpeedBps : selected.speedBps) + "/s" : "—"}
                  </strong>
                  <span>{selected.status === "verifying" ? "校验回读速度" : "实时传输速度"}</span>
                </div>
                <div>
                  <strong>
                    {selected.startedAt && selected.completedAt
                      ? duration((selected.completedAt - selected.startedAt) / 1000)
                      : (selected.status === "verifying" ? selected.verifyEta : selected.eta)
                        ? duration(selected.status === "verifying" ? selected.verifyEta : selected.eta)
                        : "—"}
                  </strong>
                  <span>{active(selected) ? "预计剩余" : "总用时"}</span>
                </div>
              </div>
              <div className="phase-head"><span>拷贝 {Math.round(selected.copyProgress || 0)}%</span><span>校验 {Math.round(selected.verifyProgress || 0)}%</span></div>
              <div className="progress-track layered-progress">
                <i className="copy-fill" style={{ width: `${selected.copyProgress || 0}%` }} />
                <i className="verify-fill" style={{ width: `${selected.verifyProgress || 0}%` }} />
              </div>
              <p className="current-file mono">
                {selected.currentFile ||
                  (selected.status === "completed"
                    ? "所有文件已完成拷贝与哈希比对"
                    : "等待或任务已停止")}
              </p>
              {selected.status === "completed" && <div className="completion-conclusion"><CheckCircle2 size={17}/><div><strong>{selected.destinations.filter((d) => d.verified).length} 个目标通过校验 · {verifiedPhysicalCopyCount(selected)} 份物理独立副本</strong><span>可以导出报告、定位副本或安全推出素材所在设备。</span></div></div>}
              {selected.errorMessage && (
                <div className="error-box">
                  <AlertTriangle size={17} />
                  {selected.errorMessage}
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
              {selected.mediaBreakdown && <div className="media-breakdown">{(["video","photo","audio","other"] as const).map((kind) => <div key={kind}><strong>{selected.mediaBreakdown![kind].files}</strong><span>{({video:"视频",photo:"照片 / RAW",audio:"音频",other:"其他"})[kind]} · {bytes(selected.mediaBreakdown![kind].bytes)}</span></div>)}</div>}
              {(selected.sourceHashHistory?.length || selected.sourceCopyReadHistory?.length || selected.performanceSummary) && <div className="source-performance-grid"><div className="performance-card"><div><strong>源素材哈希读取</strong><span>{performanceText(selected.sourceHashPerformance)}</span></div><SpeedSparkline values={(selected.sourceHashHistory || []).slice(-30).map((point) => point.speed)}/></div><div className="performance-card"><div><strong>源素材分发读取</strong><span>{performanceText(selected.sourceCopyReadPerformance)}</span></div><SpeedSparkline values={(selected.sourceCopyReadHistory || []).slice(-30).map((point) => point.speed)} color="var(--amber)"/></div><p>{selected.performanceSummary}</p></div>}
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
                    {selected.status === "completed" && d.path.startsWith("/Volumes/") && <Button kind="icon" title="安全推出此磁盘" onClick={() => void act(() => api.ejectVolume(`/Volumes/${d.path.split("/")[2]}`), "设备已安全推出")}><Eject size={15}/></Button>}
                  </div>
                  <div className="destination-status">
                    <span>拷贝 {Math.round(d.copyProgress || 0)}% · 校验 {Math.round(d.verifyProgress || 0)}% · {(selected.status === "verifying" ? d.verifySpeedBps : d.speedBps) ? `${bytes(selected.status === "verifying" ? d.verifySpeedBps : d.speedBps)}/s` : `已保存 ${bytes(d.copiedBytes || 0)} · 本次写入 ${bytes(d.bytesWritten)}`}</span>
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
                  {d.speedHistory?.length ? <div className="destination-chart"><SpeedSparkline values={d.speedHistory.map((point) => selected.status === "verifying" ? point.verify : point.copy)} color={selected.status === "verifying" ? "var(--green)" : "var(--purple)"}/><small>最近 30 秒 · {selected.status === "verifying" ? "回读" : "写入"}</small></div> : null}
                  {(d.performance || d.verifyPerformance) && <div className="performance-summary"><small>写入：{performanceText(d.performance)}</small><small>回读：{performanceText(d.verifyPerformance)}</small></div>}
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
                      <Button kind="subtle" onClick={() => void act(() => api.resumeTask(selected.id))}><Play size={14} />继续</Button>
                    ) : ["running", "verifying"].includes(selected.status) ? (
                      <Button kind="subtle" onClick={() => void act(() => api.pauseTask(selected.id))}><Pause size={14} />暂停</Button>
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
                        onClick={() =>
                          void act(() => selected.destinations.some((d) => d.verified) ? api.retryFailedDestinations(selected.id) : api.startTask(selected.id))
                        }
                      >
                        <RefreshCw size={14} />
                        {selected.destinations.some((d) => d.verified) ? "重试失败目标" : "重新执行"}
                      </Button>
                    )}
                    {selected.fileRecords.length > 0 && (
                      <Button kind="subtle" onClick={() => void act(() => api.reverifyTask(selected.id), "重新校验完成")}>
                        <ShieldCheck size={14} />重新校验
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
          >
            <AlertTriangle size={27} />
            <h2>请确认此操作</h2>
            <p>{confirm.text}</p>
            <div className="row">
              <Button onClick={() => setConfirm(null)}>取消</Button>
              <Button
                kind="primary"
                onClick={() => {
                  const action = confirm.run;
                  setConfirm(null);
                  void act(action);
                }}
              >
                确认
              </Button>
            </div>
          </section>
        </div>
      )}
      {completion && (
        <div className="modal-backdrop top-layer">
          <section className="completion-modal" role="dialog" aria-modal="true" aria-label="备份完成">
            <span className="completion-icon"><CheckCheck size={30}/></span>
            <span className="eyebrow">TRANSFER COMPLETE</span>
            <h2>备份与校验已完成</h2>
            <p>{completion.name}</p>
            <div className="completion-summary">
              <div><strong>{completion.totalFiles}</strong><span>文件</span></div>
              <div><strong>{bytes(completion.totalBytes)}</strong><span>素材大小</span></div>
              <div><strong>{completion.destinations.filter((destination) => destination.verified).length}</strong><span>校验通过目标</span></div>
              <div><strong>{duration(((completion.completedAt || Date.now()) - (completion.startedAt || completion.createdAt || Date.now())) / 1000)}</strong><span>总用时</span></div>
            </div>
            {completion.thumbnailError && <p className="muted small">{completion.thumbnailError}</p>}
            <div className="row justify-end"><Button kind="subtle" onClick={() => setCompletion(null)}>关闭</Button><Button kind="primary" onClick={() => { setDetail(completion.id); setCompletion(null); }}><FileCheck2 size={15}/>查看任务详情</Button></div>
          </section>
        </div>
      )}
      {toast && (
        <div role="status" className={`toast ${toast.error ? "error" : ""}`}>
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
  const [kind, setKind] = useState("all"),
    [limit, setLimit] = useState(100),
    [selectedPaths, setSelectedPaths] = useState<string[]>([]),
    [preview, setPreview] = useState<any>(null),
    [previewBusy, setPreviewBusy] = useState(false);
  const files = tasks.flatMap((t) =>
    t.fileRecords.map((f) => ({
      ...f,
      task: t.name,
      id: t.id + f.relativePath,
    })),
  );
  const isVideo = (name: string) => /\.(mov|mp4|mxf|mkv|avi|m4v)$/i.test(name);
  const isColor = (name: string) => /\.(cube|cdl|cc|ccc|clf)$/i.test(name);
  const filtered = files.filter(
    (f) =>
      f.name.toLowerCase().includes(query.toLowerCase()) &&
      (kind === "all" ||
        (kind === "video" && isVideo(f.name)) ||
        (kind === "color" && isColor(f.name)) ||
        (kind === "image" &&
          /\.(jpg|jpeg|png|arw|cr3|nef|dng|raf|heic)$/i.test(f.name))),
  );
  return (
    <section className="panel">
      <div className="list-toolbar">
        <div className="tabs">
          {[
            ["all", "全部文件"],
            ["video", "视频"],
            ["image", "照片 / RAW"],
            ["color", "LUT / CDL"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={kind === id ? "active" : ""}
              onClick={() => {
                setKind(id);
                setLimit(100);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="row">{selectedPaths.length > 0 && <Button kind="primary" onClick={() => proxy({name:`${selectedPaths.length} 个视频`,path:selectedPaths[0],paths:selectedPaths})}><Activity size={14}/>批量代理 {selectedPaths.length}</Button>}<SearchBox
          value={query}
          onChange={(v) => {
            setQuery(v);
            setLimit(100);
          }}
          placeholder="搜索素材文件…"
        /></div>
      </div>
      {filtered.length ? (
        <>
          <div className="library-head">
            <span>文件名称 / 所属任务</span>
            <span>大小</span>
            <span>副本状态</span>
            <span>操作</span>
          </div>
          {filtered.slice(0, limit).map((f) => {
            const verified = f.destinations.filter((d) => d.verified),
              p = verified[0]?.path;
            return (
              <div className="library-row" key={f.id}>
                <div className="row">
                  {isVideo(f.name) && p && <input type="checkbox" aria-label={`选择 ${f.name}`} checked={selectedPaths.includes(p)} onChange={(e) => setSelectedPaths((all) => e.target.checked ? [...new Set([...all,p])] : all.filter((x) => x !== p))}/>}
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
                  {verified.length} / {f.destinations.length} 已校验
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
                  {isVideo(f.name) && (
                    <>
                      <Button kind="icon" title="查看缩略图和媒体信息" disabled={!p || previewBusy} onClick={() => p && (setPreviewBusy(true), api.inspectMedia(p).then(setPreview).finally(() => setPreviewBusy(false)))}><Play size={15} /></Button>
                      <Button kind="subtle" disabled={!p} onClick={() => p && proxy({ name: f.name, path: p })}>生成代理</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <div className="library-footer">
            <span>
              显示 {Math.min(limit, filtered.length)} / {filtered.length} 个文件
              · 记录中的校验状态不代表实时磁盘检测
            </span>
            {limit < filtered.length && (
              <Button kind="subtle" onClick={() => setLimit((n) => n + 100)}>
                加载更多
              </Button>
            )}
          </div>
        </>
      ) : (
        <Empty
          icon={Film}
          title={files.length ? "没有找到匹配的素材" : "素材备份后，在这里汇合"}
          detail="保留文件结构与校验状态，可在 Finder 中定位副本，或为视频生成剪辑代理。"
        />
      )}
      {preview && (
        <div className="media-preview" role="dialog" aria-label="媒体预览">
          <button className="media-preview-close" onClick={() => setPreview(null)}><X size={16}/></button>
          {preview.thumbnail ? <img src={preview.thumbnail} alt={preview.name}/> : <div className="preview-empty"><Clapperboard size={32}/></div>}
          <div><strong>{preview.name}</strong><p>{preview.camera || "摄影机型号未知"} · {preview.duration || "时长未知"} · {bytes(preview.size)}</p><p>{[preview.resolution, preview.frameRate && `${preview.frameRate} fps`, preview.timecode && `TC ${preview.timecode}`].filter(Boolean).join(" · ") || preview.video || "未识别视频参数"}</p>{preview.audio && <p>{preview.audio}</p>}{preview.creationTime && <p>拍摄时间 {preview.creationTime}</p>}</div>
        </div>
      )}
    </section>
  );
}
function HelpPage({ go, openBackup }: { go: (page: Page) => void; openBackup: () => void }) {
  const guides: Array<{ id: string; icon: typeof HardDrive; title: string; purpose: string; steps: string[]; tips: string[]; page?: Page }> = [
    { id:"backup", icon:MemoryStick, title:"新建备份", purpose:"从素材卡或文件夹向 1–4 个目的地复制，并逐目标独立回读校验。", steps:["连接素材卡，点击“新建备份”并选择素材来源。","选择素材卡模式或拍摄项目，确认日期、设备和机位。","选择位于不同物理磁盘的目的地，检查容量和素材分类。","确认后开始；紫色表示拷贝，绿色表示独立校验。","完成弹窗显示文件、容量、通过目标与用时。"], tips:["Kocpy 不会自动开始写入。","不要把多个目录位于同一物理盘误当成独立副本。","校验完成前不要拔出素材卡或目的地。"] },
    { id:"transfers", icon:ArrowLeftRight, title:"传输队列", purpose:"查看百分比、真实速度、ETA、文件和每个目的地状态。", steps:["点击任务查看拷贝、校验和最近 30 秒速度。","需要时暂停；继续后会使用安全检查点。","失败时先阅读具体目标和文件错误，再进入恢复中心。"], tips:["“已保存”是最终有效素材量；“本次写入”是本轮物理写入量。","速度来自操作系统确认完成的字节，不是模拟数据。"], page:"transfers" },
    { id:"recovery", icon:RefreshCw, title:"恢复中心", purpose:"处理异常退出、离线磁盘、断点文件和未完成校验。", steps:["重新连接原素材卡与原目标磁盘。","确认卷名和卷身份匹配。","按提示选择从检查点继续、只重试失败目标或重新校验。","恢复后检查成功目标是否仍保持通过。"], tips:["同一路径换成另一块磁盘时会拒绝继续。","失败目标修复不会重新写入已成功目标。"], page:"recovery" },
    { id:"projects", icon:FolderKanban, title:"拍摄项目", purpose:"按日期、设备、机位和物理独立副本管理完整拍摄周期。", steps:["创建项目并设置拍摄周期、设备、机位和目的地。","设置收工需要的独立副本数量。","每天查看日期 × 设备矩阵，标记休息日或未使用设备。","项目结束后导出 PDF、JSON、CSV 或完整归档包。"], tips:["同一磁盘的多个文件夹只计算一份安全副本。","项目模板可复用设备和收工标准。"], page:"projects" },
    { id:"library", icon:Film, title:"素材库", purpose:"浏览已记录素材、缩略图、元数据与已校验副本。", steps:["按视频、照片/RAW、LUT/CDL 分类或搜索。","点击预览查看摄影机、分辨率、帧率、时间码和音轨。","只从已校验副本定位文件或创建代理。"], tips:["历史绿色状态是任务执行时的记录；长期状态请使用归档复校验。"], page:"library" },
    { id:"proxy", icon:Clapperboard, title:"代理队列", purpose:"生成 H.264 或 ProRes 剪辑代理并检查媒体一致性。", steps:["在素材库选择一个或多个已校验视频。","选择审片、剪辑或离线预设，并设置命名规则。","在队列中暂停、继续、取消或重试。","完成后检查帧率、时间码和音轨提示。","导出 Resolve、Premiere 或 Final Cut 交付清单。"], tips:["代理始终写入独立目录，不修改原素材。","暂停会清理不完整输出，继续时安全重建。"], page:"processing" },
    { id:"reports", icon:FileCheck2, title:"报告中心", purpose:"导出单任务、拍摄日和项目级校验记录。", steps:["选择任务或拍摄日。","选择 PDF、JSON、MHL、ASC MHL 或 Resolve CSV。","项目归档包同时包含报告、数据、统计、MHL 和 SHA-256。"], tips:["PDF 可包含素材首帧缩略图。","报告证明任务执行时状态，不替代后续长期复校验。"], page:"reports" },
    { id:"storage", icon:HardDrive, title:"存储设备", purpose:"查看容量、文件系统、网络延迟并安全推出设备。", steps:["确认目标可写、容量充足且不是系统备份卷。","任务完成后使用安全推出。","批量推出会保留仍被备份、代理或失败记录占用的磁盘。"], tips:["不要直接拔出正在写入或校验的设备。"], page:"storage" },
    { id:"diagnostics", icon:Gauge, title:"诊断中心", purpose:"执行受控性能预检并导出脱敏诊断包。", steps:["确保没有备份或代理任务运行。","对选定可写磁盘运行 64 MiB 写入与回读测试。","遇到问题时导出诊断包。"], tips:["测试文件会自动清理。","诊断包不包含素材内容、完整私人路径或账号。"], page:"diagnostics" },
    { id:"archive", icon:Database, title:"归档维护", purpose:"长期复校验、修复副本、数据备份与工作站合并。", steps:["定期选择项目执行长期复校验。","发现失败副本后，从另一健康副本修复。","修复前原损坏文件会改名保留。","导出本地数据备份或工作站包。","合并其他工作站记录后检查重复项和冲突。"], tips:["修复必须至少存在一份哈希匹配的健康副本。","导入前建议先导出本地数据备份。"], page:"maintenance" },
  ];
  return <div className="help-center"><section className="panel help-start"><div><span className="mini-label"><BookOpen size={13}/> QUICK START</span><h2>第一次使用 Kocpy</h2><p>推荐流程：创建项目 → 连接素材卡 → 选择不同物理盘 → 拷贝 → 独立校验 → 收工检查 → 导出报告 → 安全推出。</p></div><Button kind="primary" onClick={openBackup}><Plus size={15}/>开始第一份备份</Button></section><section className="help-safety"><ShieldCheck size={20}/><div><strong>三条安全原则</strong><p>源素材只读处理 · 每个副本独立回读校验 · 至少保存到两块不同物理磁盘</p></div></section><div className="help-grid">{guides.map(({id,icon:Icon,title,purpose,steps,tips,page}) => <details className="help-module" key={id} open={id === "backup"}><summary><span><Icon size={19}/></span><div><strong>{title}</strong><small>{purpose}</small></div><ChevronRight size={15}/></summary><div className="help-body"><h4>操作步骤</h4><ol>{steps.map((step,index)=><li key={step}><b>{index+1}</b><span>{step}</span></li>)}</ol><h4>注意事项</h4><ul>{tips.map((tip)=><li key={tip}>{tip}</li>)}</ul>{page && <Button kind="subtle" onClick={()=>go(page)}>打开{title}<ArrowRight size={13}/></Button>}</div></details>)}</div></div>;
}

function MaintenancePage({ tasks, projects, refreshProjects, notify }: { tasks: BackupTask[]; projects: ProjectConfig[]; refreshProjects: () => Promise<void>; notify: (message: string, error?: boolean) => void }) {
  const [health, setHealth] = useState<import("./api").ArchiveHealthRecord[]>([]), [templates, setTemplates] = useState<import("./api").ProjectTemplate[]>([]), [busy, setBusy] = useState<string | null>(null), [handoff, setHandoff] = useState("");
  const reload = useCallback(async () => { const [records, values] = await Promise.all([api.getArchiveHealth(), api.getProjectTemplates()]); setHealth(records); setTemplates(values); }, []);
  useEffect(() => { void reload().catch((error) => notify(String(error), true)); }, [reload, notify]);
  const run = async (key: string, action: () => Promise<unknown>, success: string) => { setBusy(key); try { await action(); await reload(); await refreshProjects(); notify(success); } catch (error) { notify(String(error).replace(/^Error: /, ""), true); } finally { setBusy(null); } };
  const lastHealth = (projectId: string) => [...health].reverse().find((record) => record.projectId === projectId);
  return <div className="maintenance-center">
    <section className="panel diagnostics-hero"><div><span className="mini-label"><span className="live-dot"/> ARCHIVE LIFECYCLE</span><h2>从现场接收到长期归档</h2><p>复校验项目副本、保存健康变化、复用项目模板，并在不同工作站之间合并任务记录。</p></div><div className="row"><Button kind="subtle" onClick={() => void run("backup", async () => { const file = await api.backupWorkspaceData(); if (file) await api.reveal(file); }, "本地数据备份已导出")}><Archive size={14}/>备份本地数据</Button><Button kind="subtle" onClick={() => void run("export", async () => { const file = await api.exportWorkspace(); if (file) await api.reveal(file); }, "工作站配置包已导出")}><Share2 size={14}/>导出工作站包</Button><Button kind="primary" onClick={() => void run("import", async () => { const result = await api.importWorkspace(); if (result) notify(`合并完成：新增 ${result.tasksAdded} 个任务，跳过 ${result.duplicates} 个重复项${result.conflicts.length ? `，${result.conflicts.length} 个冲突已记录` : ""}`); }, "工作站记录已合并")}><Download size={14}/>合并工作站包</Button></div></section>
    <section className="panel"><div className="section-title"><div><h2><ShieldCheck size={18}/>项目归档健康</h2><span className="muted small">复校验会重新读取每个副本，不依赖历史完成状态</span></div></div><div className="maintenance-projects">{projects.map((project) => { const related = tasks.filter((task) => task.projectId === project.id), last = lastHealth(project.id), failed = related.flatMap((task) => task.destinations.filter((destination) => !destination.verified).map((destination) => ({ task, destination }))); return <div className="maintenance-project" key={project.id}><div><strong>{project.name}</strong><small>{last ? `${new Date(last.checkedAt).toLocaleString("zh-CN")} · ${last.healthyTasks}/${last.taskCount} 个任务健康` : "尚未执行长期复校验"}</small></div><div className="row"><Button kind="subtle" disabled={busy !== null || !related.length} onClick={() => void run(`verify-${project.id}`, () => api.verifyProjectArchive(project.id), `${project.name} 长期复校验完成`)}>{busy === `verify-${project.id}` ? <LoaderCircle size={14} className="spin"/> : <RefreshCw size={14}/>}复校验项目</Button><Button kind="subtle" disabled={busy !== null} onClick={() => void run(`template-${project.id}`, () => api.createTemplateFromProject(project.id), "项目模板已保存")}><Copy size={14}/>保存为模板</Button>{failed.slice(0, 1).map(({task, destination}) => <Button key={destination.id} kind="danger" disabled={busy !== null} onClick={() => void run(`repair-${destination.id}`, () => api.repairArchiveCopy(task.id, destination.id), "副本已从健康来源修复；原损坏文件已保留")}><ShieldCheck size={14}/>修复失败副本</Button>)}</div></div>; })}</div></section>
    <section className="panel"><div className="section-title"><div><h2><FolderKanban size={18}/>项目模板与交接</h2><span className="muted small">模板保存设备、副本标准、命名规则与完成动作；交接记录随工作站包合并</span></div><span className="muted small">{templates.length} 个模板</span></div>{templates.length ? <div className="template-list">{templates.map((template) => <div key={template.id}><span><strong>{template.name}</strong><small>{template.devices.join(" / ")} · {template.requiredCopies} 份副本 · {template.namingRule}</small></span><div className="row"><select id={`template-project-${template.id}`} aria-label="应用模板到项目">{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><Button kind="subtle" disabled={!projects.length} onClick={() => { const select = document.getElementById(`template-project-${template.id}`) as HTMLSelectElement; void run(`apply-${template.id}`, () => api.applyProjectTemplate(template.id, select.value), "模板已应用到项目"); }}>应用</Button><Button kind="icon" title="删除模板" onClick={() => void run(`delete-${template.id}`, () => api.deleteProjectTemplate(template.id), "模板已删除")}><Trash2 size={14}/></Button></div></div>)}</div> : <Empty icon={Copy} title="还没有项目模板" detail="在上方项目中选择“保存为模板”，即可复用设备和收工标准。"/>}<div className="handoff-row"><select id="handoff-project" aria-label="交接项目">{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><input value={handoff} onChange={(event) => setHandoff(event.target.value)} placeholder="记录磁盘交接、异常说明或下一班注意事项"/><Button kind="primary" disabled={!projects.length || !handoff.trim()} onClick={() => { const select = document.getElementById("handoff-project") as HTMLSelectElement; void run("handoff", () => api.addProjectHandoff(select.value, "@sexyfeifan", handoff), "交接记录已保存").then(() => setHandoff("")); }}><Check size={14}/>保存交接</Button></div></section>
  </div>;
}

function DiagnosticsPage({ tasks, volumes, notify }: { tasks: BackupTask[]; volumes: Volume[]; notify: (message: string, error?: boolean) => void }) {
  const [running, setRunning] = useState<string | null>(null), [results, setResults] = useState<Record<string, { writeBps: number; readBps: number; durationMs: number }>>({});
  const attention = tasks.filter((task) => ["failed", "paused", "cancelled"].includes(task.status) || task.destinations.some((destination) => !destination.verified && task.status !== "running" && task.status !== "verifying"));
  const run = async (volume: Volume) => {
    setRunning(volume.path);
    try { const result = await api.runBenchmark(volume.path, 64); setResults((current) => ({ ...current, [volume.path]: result })); notify(`${volume.name} 性能预检完成，临时测试文件已清理`); }
    catch (error) { notify(String(error).replace(/^Error: /, ""), true); }
    finally { setRunning(null); }
  };
  return <div className="diagnostics-center">
    <section className="panel diagnostics-hero"><div><span className="mini-label"><span className={attention.length ? "alert-dot" : "live-dot"}/> RELIABILITY STATUS</span><h2>{attention.length ? `${attention.length} 个任务需要诊断` : "当前记录未发现待恢复风险"}</h2><p>诊断数据仅保留卷名、脱敏卷标识、容量、性能统计和错误类型，不包含素材内容与完整私人路径。</p></div><Button kind="primary" onClick={() => void api.exportDiagnostics().then((file) => file && notify(`诊断包已保存：${file}`)).catch((error) => notify(String(error), true))}><PackageSearch size={15}/>导出脱敏诊断包</Button></section>
    <section className="panel"><div className="section-title"><div><h2><Gauge size={18}/>磁盘性能预检</h2><span className="muted small">写入并回读 64 MiB 临时文件；测试结束自动清理，备份运行时禁止执行</span></div></div><div className="benchmark-grid">{volumes.map((volume) => { const result = results[volume.path]; return <div className="benchmark-card" key={volume.path}><div><HardDrive size={18}/><span><strong>{volume.name}</strong><small>{volume.isNetwork ? `${volume.protocol || "网络"} · ${volume.latencyMs || 0} ms` : volume.deviceType === "source" ? "素材设备" : "本地存储"}</small></span></div>{result ? <div className="benchmark-result"><span><b>{bytes(result.writeBps)}/s</b>写入</span><span><b>{bytes(result.readBps)}/s</b>回读</span></div> : <p>{bytes(volume.free)} 可用 · {volume.writable === false ? "只读" : "可写"}</p>}<Button kind="subtle" disabled={running !== null || volume.writable === false} onClick={() => void run(volume)}>{running === volume.path ? <LoaderCircle size={14} className="spin"/> : <Play size={14}/>}开始预检</Button></div>; })}</div></section>
    <section className="panel"><div className="section-title"><div><h2><RefreshCw size={18}/>恢复诊断</h2><span className="muted small">按当前任务状态明确区分素材源、目的地、断点和校验问题</span></div></div>{attention.length ? <div className="diagnostic-list">{attention.slice(0, 50).map((task) => { const offline = task.destinations.filter((destination) => destination.available === false).length, failed = task.destinations.filter((destination) => destination.error).length, unverified = task.destinations.filter((destination) => !destination.verified).length; const summary = task.status === "paused" ? "可从当前检查点继续" : /素材源|source/i.test(task.errorMessage || "") ? "素材源未连接或身份变化" : offline ? `${offline} 个目的地未连接` : failed ? `${failed} 个目的地写入或校验失败` : task.transferredBytes > 0 && task.transferredBytes < task.totalBytes ? "存在可复用的安全断点" : `${unverified} 个副本尚未通过校验`; return <div key={task.id}><AlertTriangle size={17}/><span><strong>{task.name}</strong><small>{summary}</small></span><Badge status={task.status}/></div>; })}</div> : <Empty icon={CheckCheck} title="诊断状态正常" detail="没有暂停、中断、失败或未完成校验的任务。"/>}</section>
  </div>;
}

function ProxyQueue({ jobs, act, refresh }: { jobs: ProxyJob[]; act: (fn: () => Promise<unknown>, success?: string) => Promise<void>; refresh: () => Promise<void> }) {
  const rows = [...jobs].reverse();
  return <section className="panel">
    <div className="section-title"><div><h2>代理处理队列 <span>{jobs.filter((j) => ["pending", "running", "paused"].includes(j.status)).length}</span></h2><span className="muted small">队列按顺序处理，保留原素材关联并检查帧率、时间码与音轨</span></div><div className="row"><Button kind="subtle" onClick={() => void act(async () => { const file = await api.exportProxyDelivery("resolve"); if (file) await api.reveal(file); }, "Resolve 交付清单已导出")}>Resolve CSV</Button><Button kind="subtle" onClick={() => void act(async () => { const file = await api.exportProxyDelivery("premiere"); if (file) await api.reveal(file); }, "Premiere 交付清单已导出")}>Premiere CSV</Button><Button kind="subtle" onClick={() => void act(async () => { const file = await api.exportProxyDelivery("fcpxml"); if (file) await api.reveal(file); }, "Final Cut XML 已导出")}>Final Cut XML</Button></div></div>
    {rows.length ? <div className="proxy-job-list">{rows.map((job) => <div className="proxy-job" key={job.id}>
      <span className={`file-icon ${job.status === "completed" ? "green" : ""}`}><Clapperboard size={19}/></span>
      <div className="proxy-job-main"><div className="row between"><strong>{job.name}</strong><span className={`badge ${job.status}`}>{({pending:"等待处理",running:"正在转码",paused:"已暂停",completed:"已完成",failed:"失败",cancelled:"已取消"} as Record<string,string>)[job.status]}</span></div><p>{job.preset === "editorial" ? "剪辑代理" : job.preset === "offline" ? "离线剪辑" : "通用审片"} · {job.format.toUpperCase()} · {job.resolution}{job.timecode ? ` · TC ${job.timecode}` : ""}</p><div className="progress-track"><i style={{width:`${job.progress}%`}} /></div>{job.validation && <small className={job.validation.notes.length ? "amber-text" : "green-text"}>{job.validation.notes.length ? job.validation.notes.join(" · ") : "帧率、时间码与音轨检查未发现异常"}</small>}{job.error && <small className="red-text">{job.error}</small>}</div>
      <div className="row">{job.status === "running" && <Button kind="subtle" onClick={() => void act(async () => { await api.pauseProxy(job.id); await refresh(); }, "代理任务正在安全暂停")}><Pause size={12}/>暂停</Button>}{job.status === "paused" && <Button kind="primary" onClick={() => void act(async () => { await api.resumeProxy(job.id); await refresh(); }, "代理任务已继续")}><Play size={12}/>继续</Button>}{job.status === "running" || job.status === "pending" ? <Button kind="danger" onClick={() => void act(async () => { await api.cancelProxy(job.id); await refresh(); }, "代理任务已取消")}><Square size={12}/>取消</Button> : null}{["failed","cancelled"].includes(job.status) && <Button kind="subtle" onClick={() => void act(async () => { await api.retryProxy(job.id); await refresh(); }, "已重新加入队列")}><RefreshCw size={13}/>重试</Button>}{job.outputPath && <Button kind="icon" title="在 Finder 中显示" onClick={() => void api.reveal(job.outputPath!)}><FolderOpen size={15}/></Button>}{!["running","pending"].includes(job.status) && <Button kind="icon" title="删除队列记录" onClick={() => void act(async () => { await api.deleteProxy(job.id); await refresh(); })}><Trash2 size={15}/></Button>}</div>
    </div>)}</div> : <Empty icon={Activity} title="代理队列为空" detail="在素材库中选择已校验的视频并加入队列，可连续处理多个代理任务。"/>}
  </section>;
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
        <div className="setting-row"><div><h3>软件更新</h3><p>{updateInfo ? updateInfo.available ? `发现 Kocpy ${updateInfo.latest} · ${updateInfo.archLabel} 安装包。` : `当前 ${updateInfo.current} 已是最新版本 · ${updateInfo.archLabel} Mac。` : "启动后自动检查官方 GitHub Release，也可以手动检查。"}</p>{updateInfo?.available && !updateInfo.downloadUrl && <small className="red-text">当前版本尚未上传与你的 Mac 架构匹配的安装包。</small>}</div><div className="row"><Button kind="subtle" onClick={() => void api.checkUpdates().then(setUpdateInfo).catch((e) => notify(String(e),true))}><RefreshCw size={14}/>检查更新</Button>{updateInfo?.available && <Button kind="primary" onClick={() => void api.openUpdate(updateInfo.downloadUrl || updateInfo.releaseUrl)}><Download size={14}/>升级到 {updateInfo.latest}</Button>}{updateInfo && <Button kind="icon" title="查看 GitHub Release" onClick={() => void api.openUpdate(updateInfo.releaseUrl)}><ExternalLink size={14}/></Button>}</div></div>
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
          <div className="segmented">
            <button
              className={draft.theme === "dark" ? "selected" : ""}
              onClick={() => setDraft({ ...draft, theme: "dark" })}
            >
              <Moon size={14} />
              深色
            </button>
            <button
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
          <div><h3>云端报告镜像</h3><p>{draft.reportSyncPath || "可选择 iCloud Drive、Dropbox 或其他同步盘文件夹；只镜像导出的报告与清单，不复制素材。"}</p></div>
          <div className="row"><Button kind="subtle" onClick={() => void api.selectDirectory().then((folder) => folder && setDraft({...draft, reportSyncPath: folder}))}><FolderOpen size={14}/>选择文件夹</Button>{draft.reportSyncPath && <Button kind="icon" title="关闭报告镜像" onClick={() => setDraft({...draft, reportSyncPath: ""})}><X size={14}/></Button>}</div>
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
            Kocpy <span>0.0.15</span>
          </h3>
          <p>
            从现场接卡、项目归档到交付报告，为每一份创作保留可靠副本。
          </p>
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
    [res, setRes] = useState<"1080p" | "720p">("1080p"),
    [preset, setPreset] = useState<"review" | "editorial" | "offline">("review"),
    [namingTemplate, setNamingTemplate] = useState("{name}_proxy_{resolution}"),
    [result, setResult] = useState(""),
    [error, setError] = useState("");
  async function run() {
    setBusy(true);
    setError("");
    try {
      await api.enqueueProxy(file.paths || [file.path], out, format, res, { preset, namingTemplate });
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
          <label>
            视频文件
            <input readOnly value={file.name} />
          </label>
          <div className="form-grid">
            <label>
              代理预设
              <select value={preset} onChange={(e) => { const value = e.target.value as "review" | "editorial" | "offline"; setPreset(value); if (value === "editorial") { setFormat("prores"); setRes("1080p"); } else if (value === "offline") { setFormat("h264"); setRes("720p"); } else { setFormat("h264"); setRes("1080p"); } }} disabled={busy}>
                <option value="review">通用审片 · H.264 1080p</option>
                <option value="editorial">剪辑代理 · ProRes 1080p</option>
                <option value="offline">离线剪辑 · H.264 720p</option>
              </select>
            </label>
            <label>
              编码格式
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as "h264" | "prores")}
                disabled={busy}
              >
                <option value="h264">H.264 · 通用预览</option>
                <option value="prores">ProRes Proxy · 剪辑</option>
              </select>
            </label>
            <label>
              最大高度
              <select
                value={res}
                onChange={(e) => setRes(e.target.value as "1080p" | "720p")}
                disabled={busy}
              >
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
              </select>
            </label>
          </div>
          <label>
            输出命名规则
            <input value={namingTemplate} onChange={(e) => setNamingTemplate(e.target.value)} disabled={busy} placeholder="{name}_proxy_{resolution}" />
            <span className="muted small">支持 {'{name}'}、{'{resolution}'}、{'{format}'}；始终追加唯一短码且不覆盖已有文件。</span>
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
            <div className="success-box">
              <CheckCircle2 size={17} />
              {result}，可在「代理队列」查看进度、取消或重试。
            </div>
          )}
          {error && <div className="error-box">{error}</div>}
        </div>
        <div className="modal-footer">
          <span className="small muted">唯一文件名 · 不覆盖已有文件</span>
          <Button
            kind="primary"
            disabled={busy || !out || !!result}
            onClick={() => void run()}
          >
            <Play size={15} />
            {busy ? "生成中…" : result ? "已完成" : "开始生成"}
          </Button>
        </div>
      </section>
    </div>
  );
}
