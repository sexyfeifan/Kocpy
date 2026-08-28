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
} from "./api";
import { Composer } from "./Composer";
import { ProjectEditor } from "./ProjectEditor";

type Page =
  | "overview"
  | "transfers"
  | "recovery"
  | "projects"
  | "library"
  | "processing"
  | "reports"
  | "storage"
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
];
const projectDates = (project: ProjectConfig, tasks: BackupTask[]) => {
  const result: string[] = [], start = project.shootingDateStart, end = project.shootingDateEnd || start;
  if (start && end) for (let cursor = new Date(`${start}T12:00:00`), finish = new Date(`${end}T12:00:00`); cursor <= finish && result.length < 1000; cursor.setDate(cursor.getDate() + 1)) result.push(cursor.toLocaleDateString("sv-SE"));
  return [...new Set([...result, ...tasks.map((task) => task.shootingDate).filter(Boolean) as string[]])].sort();
};
const projectCell = (project: ProjectConfig, tasks: BackupTask[], shootingDate: string, device: string) => {
  const rows = tasks.filter((task) => task.shootingDate === shootingDate && task.devices.includes(device)), required = project.requiredCopies || 2;
  const rest = project.restDays?.includes(shootingDate), unused = project.unusedDevicesByDate?.[shootingDate]?.includes(device);
  const safe = rows.filter((task) => task.status === "completed" && task.destinations.filter((destination) => destination.verified).length >= required).length;
  return { rows, safe, exempt: Boolean(rest || unused), label: rest ? "休息日" : unused ? "当天未使用" : rows.length && safe === rows.length ? "已满足收工要求" : rows.length ? `${safe} / ${rows.length} 达到 ${required} 份副本` : "尚未备份" };
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
              Kocpy<span>0.0.10</span>
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
              <b>v0.0.10</b>
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
                {recoveryTasks.length ? <div className="recovery-list">{recoveryTasks.map((task) => { const failedTargets = task.destinations.filter((destination) => destination.available === false || destination.error || !destination.verified); return <div key={task.id}><span className="file-icon"><RefreshCw size={18}/></span><div><strong>{task.name}</strong><p>{task.status === "paused" ? "任务已暂停，可从当前检查点继续" : task.status === "cancelled" && task.transferredBytes ? "检测到已传输数据，重新执行会校验并复用安全断点" : failedTargets.length ? `${failedTargets.length} 个目标需要重新连接或重试` : "任务尚未完成"}</p><small>{task.currentFile || task.errorMessage || task.sourcePath}</small></div><div className="row"><Badge status={task.status}/>{task.status === "paused" ? <Button kind="primary" onClick={() => void act(() => api.resumeTask(task.id), "任务已继续")}><Play size={13}/>继续</Button> : <Button kind="subtle" onClick={() => void act(() => api.startTask(task.id), "已重新加入恢复队列")}><RefreshCw size={13}/>恢复任务</Button>}{failedTargets.length > 0 && <Button kind="subtle" onClick={() => void act(() => api.retryFailedDestinations(task.id), "失败目标已单独重试")}><HardDrive size={13}/>重试目标</Button>}{task.fileRecords.length > 0 && <Button kind="subtle" onClick={() => void act(() => api.reverifyTask(task.id), "复校验已完成")}><ShieldCheck size={13}/>重新校验</Button>}</div></div>; })}</div> : <Empty icon={CheckCheck} title="没有需要恢复的任务" detail="所有任务、目的地和校验记录均处于安全状态。"/>}
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
                          <div className="project-day-progress"><strong>项目素材进度</strong>{p.devices.map((device) => { const deviceTasks = tasks.filter((task) => task.projectId === p.id && task.devices.includes(device)); const verified = deviceTasks.filter((task) => task.status === "completed").length, size = deviceTasks.reduce((sum, task) => sum + task.totalBytes, 0); return <div key={device}><span>{device}</span><small className={verified && verified === deviceTasks.length ? "green-text" : "muted"}>{deviceTasks.length ? `${verified} / ${deviceTasks.length} 已校验 · ${bytes(size)}` : "尚未备份"}</small></div>; })}</div>
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
                    <div className="project-total-cards"><div><strong>{projectDetailTasks.length}</strong><span>素材卷任务</span></div><div><strong>{projectDetailTasks.filter((task) => task.status === "completed").length} / {projectDetailTasks.length}</strong><span>已完成校验</span></div><div><strong>{projectDetailTasks.reduce((sum, task) => sum + task.totalFiles, 0)}</strong><span>项目文件</span></div><div><strong>{bytes(projectDetailTasks.reduce((sum, task) => sum + task.totalBytes, 0))}</strong><span>项目总素材</span></div></div>
                    <div className="closeout-note"><ShieldCheck size={16}/><span>收工标准：每个使用中的设备至少有 {projectDetail.requiredCopies || 2} 份独立校验副本。点击状态可标记休息日或当天未使用设备。</span></div>
                    <div className="project-matrix"><div className="project-matrix-head"><span>拍摄日期</span><span>设备 / 机位</span><span>素材卷</span><span>文件</span><span>素材量</span><span>收工检查</span></div>{projectDates(projectDetail, projectDetailTasks).flatMap((shootingDate) => projectDetail.devices.map((device) => { const cell = projectCell(projectDetail, projectDetailTasks, shootingDate, device), rows = cell.rows; return <div className="project-matrix-row" key={`${shootingDate}-${device}`}><strong>{shootingDate.replace(/-/g, "")}</strong><span>{device}</span><span>{rows.length}</span><span>{rows.reduce((sum, task) => sum + task.totalFiles, 0)}</span><span>{bytes(rows.reduce((sum, task) => sum + task.totalBytes, 0))}</span><button className={cell.exempt || (rows.length && cell.safe === rows.length) ? "green-text" : rows.length ? "amber-text" : "muted"} onClick={() => void updateProjectSchedule(projectDetail, shootingDate, device)} title="切换当天未使用标记">{cell.label}</button></div>; }))}</div>
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
              {selected.status === "completed" && <div className="completion-conclusion"><CheckCircle2 size={17}/><div><strong>{selected.destinations.filter((d) => d.verified).length} 个目标均通过独立校验</strong><span>可以导出报告、定位副本或安全推出素材所在设备。</span></div></div>}
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
              {(selected.sourceSpeedHistory?.length || selected.performanceSummary) && <div className="performance-card"><div><strong>素材源读取</strong><span>{selected.sourceReadSpeedBps ? `${bytes(selected.sourceReadSpeedBps)}/s` : selected.performanceSummary}</span></div><SpeedSparkline values={(selected.sourceSpeedHistory || []).map((point) => point.speed)}/></div>}
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
function ProxyQueue({ jobs, act, refresh }: { jobs: ProxyJob[]; act: (fn: () => Promise<unknown>, success?: string) => Promise<void>; refresh: () => Promise<void> }) {
  const rows = [...jobs].reverse();
  return <section className="panel">
    <div className="section-title"><h2>代理处理队列 <span>{jobs.filter((j) => ["pending", "running"].includes(j.status)).length}</span></h2><span className="muted small">队列按顺序处理，应用重启后可继续重试</span></div>
    {rows.length ? <div className="proxy-job-list">{rows.map((job) => <div className="proxy-job" key={job.id}>
      <span className={`file-icon ${job.status === "completed" ? "green" : ""}`}><Clapperboard size={19}/></span>
      <div className="proxy-job-main"><div className="row between"><strong>{job.name}</strong><span className={`badge ${job.status}`}>{({pending:"等待处理",running:"正在转码",completed:"已完成",failed:"失败",cancelled:"已取消"} as Record<string,string>)[job.status]}</span></div><p>{job.format.toUpperCase()} · {job.resolution}{job.timecode ? ` · TC ${job.timecode}` : ""}</p><div className="progress-track"><i style={{width:`${job.progress}%`}} /></div>{job.error && <small className="red-text">{job.error}</small>}</div>
      <div className="row">{job.status === "running" || job.status === "pending" ? <Button kind="danger" onClick={() => void act(async () => { await api.cancelProxy(job.id); await refresh(); }, "代理任务已取消")}><Square size={12}/>取消</Button> : null}{["failed","cancelled"].includes(job.status) && <Button kind="subtle" onClick={() => void act(async () => { await api.retryProxy(job.id); await refresh(); }, "已重新加入队列")}><RefreshCw size={13}/>重试</Button>}{job.outputPath && <Button kind="icon" title="在 Finder 中显示" onClick={() => void api.reveal(job.outputPath!)}><FolderOpen size={15}/></Button>}{!["running","pending"].includes(job.status) && <Button kind="icon" title="删除队列记录" onClick={() => void act(async () => { await api.deleteProxy(job.id); await refresh(); })}><Trash2 size={15}/></Button>}</div>
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
            Kocpy <span>0.0.10</span>
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
    [result, setResult] = useState(""),
    [error, setError] = useState("");
  async function run() {
    setBusy(true);
    setError("");
    try {
      await api.enqueueProxy(file.paths || [file.path], out, format, res);
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
