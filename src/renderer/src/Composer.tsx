import { useState, useEffect, useRef } from "react";
import {
  Plus,
  X,
  MemoryStick,
  HardDrive,
  FolderOpen,
  ArrowRight,
  ChevronLeft,
  Check,
  ShieldCheck,
  LoaderCircle,
  Info,
  FolderKanban,
  Play,
  AlertTriangle,
} from "lucide-react";
import {
  api,
  bytes,
  leaf,
  previewVolumeTimestamp,
  today,
  type ProjectConfig,
  type Volume,
  type Settings,
  type Scan,
} from "./api";
import { Button } from "./App";
interface Source {
  path: string;
  scan?: Scan;
}
const CAMERA_POSITIONS = ["A", "B", "C", "D", "E"];
const shootingDates = (start?: string, end?: string) => {
  if (!start) return [today()];
  const values: string[] = [],
    finish = end || start;
  for (
    let date = new Date(`${start}T12:00:00`);
    date <= new Date(`${finish}T12:00:00`) && values.length < 1000;
    date.setDate(date.getDate() + 1)
  )
    values.push(date.toLocaleDateString("sv-SE"));
  return values;
};
export function Composer({
  initial,
  volumes,
  projects,
  settings,
  onClose,
  onCreated,
  onCreateProject,
}: {
  initial: { source?: string; project?: ProjectConfig };
  volumes: Volume[];
  projects: ProjectConfig[];
  settings: Settings;
  onClose: () => void;
  onCreated: () => Promise<void>;
  onCreateProject: () => void;
}) {
  const [step, setStep] = useState(0),
    [sources, setSources] = useState<Source[]>(
      initial.source ? [{ path: initial.source }] : [],
    ),
    [sourceInput, setSourceInput] = useState(""),
    [destInput, setDestInput] = useState(""),
    [dests, setDests] = useState<string[]>(
      initial.project?.destinationPaths || [],
    );
  const [mode, setMode] = useState<"card" | "project">(
      initial.project ? "project" : "card",
    ),
    [projectId, setProjectId] = useState(initial.project?.id || ""),
    [shootDate, setShootDate] = useState(today()),
    [camera, setCamera] = useState(initial.project?.devices[0] || "A机"),
    [multiPosition, setMultiPosition] = useState(
      Boolean(
        initial.project?.devicePositions?.[initial.project?.devices[0] || ""]
          ?.length,
      ),
    ),
    [cameraPosition, setCameraPosition] = useState(
      initial.project?.devicePositions?.[
        initial.project?.devices[0] || ""
      ]?.[0] || "A",
    ),
    [name, setName] = useState(""),
    [algorithm, setAlgorithm] = useState(settings.defaultHash),
    [duplicate, setDuplicate] = useState(settings.defaultDuplicateStrategy),
    [hidden, setHidden] = useState(settings.includeHidden),
    [mirror, setMirror] = useState(false),
    [priority, setPriority] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [spaces, setSpaces] = useState<Record<string, number>>({}),
    [detectedScans, setDetectedScans] = useState<
      Record<string, Scan | "loading" | "error">
    >({});
  const [draggingDestination, setDraggingDestination] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const project = projects.find((p) => p.id === projectId),
    total = sources.reduce((n, s) => n + (s.scan?.totalBytes || 0), 0),
    externalVolumes = volumes.filter(
      (volume) => volume.path.startsWith("/Volumes/") && !volume.isNetwork,
    ),
    availablePositions = project?.devicePositions?.[camera]?.length
      ? project.devicePositions[camera]
      : CAMERA_POSITIONS;
  const previewStamp = previewVolumeTimestamp(new Date(clock));
  const previewPrefixRaw =
    name.trim() ||
    project?.volumePrefixByDevice?.[camera] ||
    project?.volumePrefix ||
    `${camera}_`;
  const previewPrefix = `${previewPrefixRaw.replace(/_+$/, "")}_`;
  const previewVolumeName = (index: number) => {
    const previous =
      project?.lastVolumeTimestampByDevice?.[camera] === previewStamp
        ? project?.volumeTimestampCollisionByDevice?.[camera] || 0
        : -1;
    const collision = previous + index + 1;
    return `${previewPrefix}${previewStamp}${collision > 0 ? `_${String(collision + 1).padStart(2, "0")}` : ""}`;
  };
  useEffect(() => {
    dialog.current?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const all = [
        ...dialog.current!.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        ),
      ];
      const first = all[0],
        last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    dialog.current?.addEventListener("keydown", trap);
    return () => dialog.current?.removeEventListener("keydown", trap);
  }, []);
  useEffect(() => {
    if (!initial.project?.id) return;
    setMode("project");
    setProjectId(initial.project.id);
    setDests(initial.project.destinationPaths || []);
    setCamera(initial.project.devices[0] || "FX3");
    const firstDevice = initial.project.devices[0] || "FX3";
    const configuredPositions =
      initial.project.devicePositions?.[firstDevice] || [];
    setMultiPosition(Boolean(configuredPositions.length));
    setCameraPosition(configuredPositions[0] || "A");
    const start = initial.project.shootingDateStart || today();
    const end = initial.project.shootingDateEnd || start;
    const now = today();
    setShootDate(now >= start && now <= end ? now : start);
  }, [initial.project]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    for (const volume of externalVolumes.filter(
      (item) => item.deviceType === "source",
    )) {
      if (detectedScans[volume.path]) continue;
      setDetectedScans((all) => ({ ...all, [volume.path]: "loading" }));
      void api
        .scanSource(volume.path, hidden)
        .then((scan) =>
          setDetectedScans((all) => ({ ...all, [volume.path]: scan })),
        )
        .catch(() =>
          setDetectedScans((all) => ({ ...all, [volume.path]: "error" })),
        );
    }
  }, [
    externalVolumes
      .map((volume) => `${volume.path}:${volume.deviceType}`)
      .join("|"),
    hidden,
  ]);
  useEffect(() => {
    if (!projectId) return;
    localStorage.setItem(
      `kocpy-project-choice-${projectId}`,
      JSON.stringify({ shootDate, camera, multiPosition, cameraPosition }),
    );
  }, [projectId, shootDate, camera, multiPosition, cameraPosition]);
  async function attempt(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  function addSource(p: string) {
    p = p.trim();
    if (!p) return;
    if (!p.startsWith("/")) {
      setError("请输入绝对文件夹路径");
      return;
    }
    setSources((old) =>
      old.some((s) => s.path === p) ? old : [...old, { path: p }],
    );
    setSourceInput("");
    setError("");
  }
  function addDest(p: string) {
    p = p.trim();
    if (!p) return;
    if (!p.startsWith("/")) {
      setError("请输入绝对文件夹路径");
      return;
    }
    setDests((old) =>
      old.includes(p) ? old : old.length < 4 ? [...old, p] : old,
    );
    setDestInput("");
    setError("");
  }
  async function next() {
    await attempt(async () => {
      if (step === 0) {
        if (!sources.length) throw new Error("请先添加素材源");
        if (mode === "project" && !project)
          throw new Error("请先选择或新建拍摄项目");
        const scanned: Source[] = [];
        for (const s of sources) {
          const scan = await api.scanSource(s.path, hidden);
          if (!scan.totalFiles)
            throw new Error(`${leaf(s.path)} 没有可备份文件`);
          scanned.push({ ...s, scan });
          setDetectedScans((all) => ({ ...all, [s.path]: scan }));
        }
        setSources(scanned);
        setStep(1);
      } else if (step === 1) {
        if (!dests.length) throw new Error("请添加至少一个目的地");
        if (mode === "project" && !project) throw new Error("请选择拍摄项目");
        if (mode === "project" && project) {
          const required = project.requiredCopies || 2;
          const physical = new Set(
            dests.map(
              (destination) =>
                volumes.find(
                  (volume) =>
                    destination === volume.path ||
                    destination.startsWith(`${volume.path}/`),
                )?.identity?.uuid ||
                volumes.find(
                  (volume) =>
                    destination === volume.path ||
                    destination.startsWith(`${volume.path}/`),
                )?.identity?.id ||
                destination,
            ),
          );
          if (dests.length < required || physical.size < required)
            throw new Error(
              `项目要求 ${required} 份物理独立副本，请增加位于不同磁盘的目的地`,
            );
        }
        const space: Record<string, number> = {};
        for (const d of dests) {
          try {
            space[d] = (await api.driveInfo(d)).free;
          } catch {
            /* New nested folders are checked by engine before copying. */
          }
        }
        setSpaces(space);
        if (Object.values(space).some((v) => v < total))
          throw new Error("某个目的地空间不足，请选择其他设备");
        setStep(2);
      }
    });
  }
  async function start() {
    await attempt(async () => {
      for (const source of sources) {
        const claimed =
          mode === "project" && project
            ? await api.claimProjectVolume(
                project.id,
                camera,
                name || undefined,
              )
            : undefined;
        const automaticName = claimed?.label || leaf(source.path);
        const taskName =
          mode === "project" ? automaticName : name || automaticName;
        const config = {
          name: taskName,
          sourcePath: source.path,
          destinationPaths: dests,
          hashAlgorithm: algorithm,
          namingTemplate: taskName
            ? sources.length > 1
              ? `${taskName}_${leaf(source.path)}`
              : taskName
            : leaf(source.path),
          devices: mode === "project" ? [camera] : [],
          cameraPosition:
            mode === "project" && multiPosition ? cameraPosition : undefined,
          shootingDate: mode === "project" ? shootDate : "",
          projectName: mode === "project" ? project?.name : undefined,
          projectStartDate:
            mode === "project" ? project?.shootingDateStart : undefined,
          projectFolderName:
            mode === "project" ? project?.projectFolderName : undefined,
          projectNamingRule:
            mode === "project" ? project?.namingRule : undefined,
          projectId: mode === "project" ? project?.id : undefined,
          copyMode: mirror ? ("mirror" as const) : ("normal" as const),
          duplicateStrategy: duplicate,
          includeHidden: hidden,
          priority,
        };
        const task = await api.createTask(config);
        await api.startTask(task.id);
      }
      await onCreated();
    });
  }
  function chooseProject(id: string) {
    setProjectId(id);
    const p = projects.find((p) => p.id === id);
    if (p) {
      setDests(p.destinationPaths || []);
      const start = p.shootingDateStart || today(),
        end = p.shootingDateEnd || start,
        now = today();
      let recent: {
        shootDate?: string;
        camera?: string;
        multiPosition?: boolean;
        cameraPosition?: string;
      } = {};
      try {
        recent = JSON.parse(
          localStorage.getItem(`kocpy-project-choice-${id}`) || "{}",
        );
      } catch {
        /* Ignore damaged local preference. */
      }
      const selectedCamera =
        recent.camera && p.devices.includes(recent.camera)
          ? recent.camera
          : p.devices[0] || "FX3";
      const configuredPositions = p.devicePositions?.[selectedCamera] || [];
      setCamera(selectedCamera);
      setMultiPosition(
        Boolean(configuredPositions.length) && recent.multiPosition !== false,
      );
      setCameraPosition(
        recent.cameraPosition &&
          configuredPositions.includes(recent.cameraPosition)
          ? recent.cameraPosition
          : configuredPositions[0] || "A",
      );
      setShootDate(
        recent.shootDate && recent.shootDate >= start && recent.shootDate <= end
          ? recent.shootDate
          : now >= start && now <= end
            ? now
            : start,
      );
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="composer-modal"
        role="dialog"
        aria-modal="true"
        aria-busy={busy}
        aria-label="新建备份任务"
        tabIndex={-1}
        ref={dialog}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">NEW TRANSFER</span>
            <h2>让素材，安心抵达。</h2>
          </div>
          <Button
            kind="icon"
            title="关闭新建备份"
            disabled={busy}
            onClick={onClose}
          >
            <X size={21} />
          </Button>
        </div>
        <div className="wizard-steps">
          {[
            ["选择素材源", MemoryStick],
            ["设置目的地", HardDrive],
            ["确认与开始", ShieldCheck],
          ].map(([label, Icon], i) => {
            const I = Icon as typeof MemoryStick;
            return (
              <div
                className={`wizard-step ${step === i ? "current" : step > i ? "done" : ""}`}
                key={i}
              >
                <span>{step > i ? <Check size={15} /> : <I size={16} />}</span>
                <strong>{String(label)}</strong>
                <small>0{i + 1}</small>
                {i < 2 && <ArrowRight size={15} />}
              </div>
            );
          })}
        </div>
        <div className="composer-body">
          <div className="composer-main">
            {step === 0 && (
              <>
                <div className="form-section-title">
                  <h3>你的素材在哪里？</h3>
                  <p>源文件只读，完整保留目录结构。</p>
                </div>
                <div className="mode-grid">
                  {[
                    [
                      "card",
                      "素材卡备份",
                      "每个源建立独立备份文件夹",
                      MemoryStick,
                    ],
                    [
                      "project",
                      "项目备份",
                      "按项目 / 拍摄日 / 设备 / 素材卷整理",
                      FolderKanban,
                    ],
                  ].map(([id, title, desc, Icon]) => {
                    const I = Icon as typeof MemoryStick;
                    return (
                      <button
                        key={String(id)}
                        className={`mode-card ${mode === id ? "selected" : ""}`}
                        disabled={busy}
                        onClick={() => setMode(id as typeof mode)}
                      >
                        <I size={20} />
                        <strong>{String(title)}</strong>
                        <span>{String(desc)}</span>
                        {mode === id && <Check size={13} />}
                      </button>
                    );
                  })}
                </div>
                {mode === "project" && (
                  <div className="project-picker">
                    <div className="dest-heading">
                      <span>选择拍摄项目</span>
                      <Button kind="subtle" onClick={onCreateProject}>
                        <Plus size={14} />
                        新建项目
                      </Button>
                    </div>
                    <div className="project-choice-grid">
                      {projects
                        .filter((item) => item.status !== "archived")
                        .map((item) => (
                          <button
                            key={item.id}
                            className={projectId === item.id ? "selected" : ""}
                            onClick={() => chooseProject(item.id)}
                          >
                            <FolderKanban size={18} />
                            <span>
                              <strong>{item.name}</strong>
                              <small>
                                {item.projectFolderName ||
                                  `${(item.shootingDateStart || "").replace(/-/g, "")}_${item.name}`}{" "}
                                · {item.devices.length} 个设备
                              </small>
                            </span>
                            {projectId === item.id && <Check size={14} />}
                          </button>
                        ))}
                    </div>
                    {!projects.some((item) => item.status !== "archived") && (
                      <div className="notice">
                        <Info size={15} />
                        还没有拍摄项目。请先在这里新建，保存后即可继续选择素材源。
                      </div>
                    )}
                  </div>
                )}
                <div
                  className="source-drop"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!busy)
                      for (const f of Array.from(e.dataTransfer.files)) {
                        const p = (f as File & { path?: string }).path;
                        if (p) addSource(p);
                      }
                  }}
                >
                  <span className="drop-icon">
                    <FolderOpen size={26} />
                  </span>
                  <h3>选择或拖入素材文件夹</h3>
                  <p>支持素材卡和待归档目录；每个来源建立独立素材卷任务</p>
                  <Button
                    kind="subtle"
                    disabled={busy}
                    onClick={() =>
                      void attempt(async () => {
                        const p = await api.selectDirectory();
                        if (p) addSource(p);
                      })
                    }
                  >
                    <Plus size={15} />
                    选择文件夹
                  </Button>
                </div>
                <div className="manual-path">
                  <input
                    aria-label="素材源路径"
                    placeholder="或输入绝对路径，回车添加"
                    value={sourceInput}
                    disabled={busy}
                    onChange={(e) => setSourceInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addSource(sourceInput);
                    }}
                  />
                  <Button
                    kind="icon"
                    title="添加输入的素材源"
                    disabled={!sourceInput || busy}
                    onClick={() => addSource(sourceInput)}
                  >
                    <Plus size={17} />
                  </Button>
                </div>
                {sources.map((s) => (
                  <div className="chosen-path" key={s.path}>
                    <MemoryStick size={20} />
                    <div>
                      <strong>{leaf(s.path)}</strong>
                      <span title={s.path}>{s.path}</span>
                    </div>
                    <Button
                      kind="icon"
                      title={`移除素材源 ${leaf(s.path)}`}
                      disabled={busy}
                      onClick={() =>
                        setSources((all) =>
                          all.filter((x) => x.path !== s.path),
                        )
                      }
                    >
                      <X size={15} />
                    </Button>
                  </div>
                ))}
                <div className="detected-storage">
                  <div className="detected-storage-heading">
                    <span>已识别外接存储设备</span>
                    <span>{externalVolumes.length} 个本地卷</span>
                  </div>
                  {externalVolumes.length ? (
                    <div className="detected-storage-grid">
                      {externalVolumes.map((volume) => {
                        const selected = sources.some(
                          (source) => source.path === volume.path,
                        );
                        const selectedScan = sources.find(
                            (source) => source.path === volume.path,
                          )?.scan,
                          detected = selectedScan || detectedScans[volume.path];
                        const material =
                          detected === "loading"
                            ? "正在计算待备份素材…"
                            : detected === "error"
                              ? "素材大小读取失败，选择后重试"
                              : detected
                                ? `待备份 ${bytes(detected.totalBytes)} · ${detected.totalFiles} 个文件`
                                : "选择后扫描实际素材";
                        return (
                          <button
                            key={volume.path}
                            className={selected ? "selected" : ""}
                            disabled={busy}
                            onClick={() =>
                              selected
                                ? setSources((all) =>
                                    all.filter(
                                      (source) => source.path !== volume.path,
                                    ),
                                  )
                                : addSource(volume.path)
                            }
                          >
                            <MemoryStick size={16} />
                            <span>
                              <strong>{volume.name}</strong>
                              <small>
                                {volume.deviceType === "source"
                                  ? `素材卡 · ${material}`
                                  : `外接数据盘 · ${material}`}
                              </small>
                              <em>
                                总容量 {bytes(volume.total)} · 可用{" "}
                                {bytes(volume.free)}
                              </em>
                            </span>
                            {selected ? (
                              <Check size={14} />
                            ) : (
                              <Plus size={14} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="notice">
                      <Info size={14} />
                      暂未检测到本地外接盘，连接后可返回此步骤刷新。
                    </div>
                  )}
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <div className="form-section-title">
                  <h3>把副本，放在可靠的地方。</h3>
                  <p>最多添加 4 个目的地。建议使用不同物理磁盘。</p>
                </div>
                {sources.some(
                  (source) => source.scan?.suggestion?.duplicateTaskId,
                ) && (
                  <div className="error-box">
                    <AlertTriangle size={16} />
                    检测到与历史任务“
                    {
                      sources.find(
                        (source) => source.scan?.suggestion?.duplicateTaskId,
                      )?.scan?.suggestion?.duplicateTaskName
                    }
                    ”相同的文件结构和容量。请确认这不是已经接收过的素材卡。
                  </div>
                )}
                {!sources.some(
                  (source) => source.scan?.suggestion?.duplicateTaskId,
                ) &&
                  sources.some(
                    (source) => source.scan?.suggestion?.projectId,
                  ) && (
                    <div className="notice">
                      <Info size={15} />
                      根据素材卡历史记录，建议继续项目“
                      {projects.find(
                        (item) =>
                          item.id ===
                          sources.find(
                            (source) => source.scan?.suggestion?.projectId,
                          )?.scan?.suggestion?.projectId,
                      )?.name || "历史项目"}
                      ”、设备{" "}
                      {
                        sources.find(
                          (source) => source.scan?.suggestion?.device,
                        )?.scan?.suggestion?.device
                      }
                      ，下一卷号{" "}
                      {
                        sources.find(
                          (source) => source.scan?.suggestion?.nextVolume,
                        )?.scan?.suggestion?.nextVolume
                      }
                      。Kocpy 不会自动开始写入。
                    </div>
                  )}
                {sources.some((source) => source.scan?.breakdown) && (
                  <div className="source-breakdown">
                    {(["video", "photo", "audio", "other"] as const).map(
                      (kind) => {
                        const files = sources.reduce(
                            (sum, source) =>
                              sum +
                              (source.scan?.breakdown?.[kind]?.files || 0),
                            0,
                          ),
                          size = sources.reduce(
                            (sum, source) =>
                              sum +
                              (source.scan?.breakdown?.[kind]?.bytes || 0),
                            0,
                          );
                        return (
                          <div key={kind}>
                            <strong>{files}</strong>
                            <span>
                              {
                                {
                                  video: "视频",
                                  photo: "照片 / RAW",
                                  audio: "音频",
                                  other: "其他",
                                }[kind]
                              }{" "}
                              · {bytes(size)}
                            </span>
                          </div>
                        );
                      },
                    )}
                  </div>
                )}
                {mode === "project" && (
                  <div className="project-form">
                    <div className="selected-project">
                      <FolderKanban size={20} />
                      <div>
                        <span>当前项目</span>
                        <strong>{project?.name}</strong>
                        <small className="mono">
                          {project?.projectFolderName ||
                            `${(project?.shootingDateStart || "").replace(/-/g, "")}_${project?.name}`}
                        </small>
                      </div>
                      <Button kind="subtle" onClick={() => setStep(0)}>
                        更换项目
                      </Button>
                    </div>
                    <div className="project-column-browser">
                      <section>
                        <span>01 · 项目</span>
                        <button className="selected">
                          <FolderKanban size={15} />
                          <strong>{project?.projectFolderName}</strong>
                        </button>
                      </section>
                      <section>
                        <span>02 · 拍摄日期</span>
                        <div className="column-options">
                          {shootingDates(
                            project?.shootingDateStart,
                            project?.shootingDateEnd,
                          ).map((date) => (
                            <button
                              key={date}
                              className={shootDate === date ? "selected" : ""}
                              onClick={() => setShootDate(date)}
                            >
                              <strong>{date.replace(/-/g, "")}</strong>
                              <small>
                                {date === today()
                                  ? "今天"
                                  : new Date(
                                      `${date}T12:00:00`,
                                    ).toLocaleDateString("zh-CN", {
                                      month: "long",
                                      day: "numeric",
                                      weekday: "short",
                                    })}
                              </small>
                            </button>
                          ))}
                        </div>
                      </section>
                      <section>
                        <span>03 · 设备 / 机位</span>
                        <div className="column-options">
                          {(project?.devices.length
                            ? project.devices
                            : ["FX3"]
                          ).map((device) => (
                            <button
                              key={device}
                              className={camera === device ? "selected" : ""}
                              onClick={() => {
                                const configured =
                                  project?.devicePositions?.[device] || [];
                                setCamera(device);
                                setMultiPosition(Boolean(configured.length));
                                setCameraPosition(configured[0] || "A");
                              }}
                            >
                              <strong>{device}</strong>
                              <small>
                                {project?.devicePositions?.[device]?.length
                                  ? `${project.devicePositions[device].join(" / ")} 多机位`
                                  : "单机位目录"}
                              </small>
                            </button>
                          ))}
                        </div>
                      </section>
                      <section>
                        <span>04 · 同型号机位</span>
                        {project?.devicePositions?.[camera]?.length ? (
                          <div className="column-options">
                            <button
                              className={!multiPosition ? "selected" : ""}
                              onClick={() => setMultiPosition(false)}
                            >
                              <strong>不分机位</strong>
                              <small>直接保存到 {camera}</small>
                            </button>
                            {availablePositions.map((position) => (
                              <button
                                key={position}
                                className={
                                  multiPosition && cameraPosition === position
                                    ? "selected"
                                    : ""
                                }
                                onClick={() => {
                                  setMultiPosition(true);
                                  setCameraPosition(position);
                                }}
                              >
                                <strong>{position}</strong>
                                <small>
                                  {camera} · {position} 机
                                </small>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="column-empty">
                            <Check size={15} />
                            该设备使用单机位目录
                          </div>
                        )}
                      </section>
                    </div>
                    <div className="project-breadcrumb">
                      <span>{project?.projectFolderName}</span>
                      <ArrowRight size={12} />
                      <span>{shootDate.replace(/-/g, "")}</span>
                      <ArrowRight size={12} />
                      <span>{camera}</span>
                      {multiPosition && (
                        <>
                          <ArrowRight size={12} />
                          <strong>{cameraPosition}</strong>
                        </>
                      )}
                    </div>
                  </div>
                )}
                <div className="destination-volume-picker">
                  <div className="detected-storage-heading">
                    <span>从外接磁盘选择目的地</span>
                    <span>点击磁盘后继续选择其中的目标文件夹</span>
                  </div>
                  <div>
                    {externalVolumes
                      .filter(
                        (volume) =>
                          volume.writable !== false &&
                          !sources.some(
                            (source) => source.path === volume.path,
                          ),
                      )
                      .map((volume) => (
                        <button
                          key={volume.path}
                          disabled={busy}
                          onClick={() =>
                            void attempt(async () => {
                              const selected = await api.selectDirectory(
                                volume.path,
                              );
                              if (selected) addDest(selected);
                            })
                          }
                        >
                          <HardDrive size={17} />
                          <span>
                            <strong>{volume.name}</strong>
                            <small>
                              总容量 {bytes(volume.total)} · 可用{" "}
                              {bytes(volume.free)}
                            </small>
                          </span>
                          <FolderOpen size={14} />
                        </button>
                      ))}
                  </div>
                  {!externalVolumes.some(
                    (volume) =>
                      volume.writable !== false &&
                      !sources.some((source) => source.path === volume.path),
                  ) && (
                    <small className="muted">
                      暂无可用外接目标盘，也可以使用下方“添加备份目的地”。
                    </small>
                  )}
                </div>
                <div className="dest-heading">
                  <span>备份目的地</span>
                  <span>{dests.length} / 4</span>
                </div>
                {dests.map((d, i) => (
                  <div className="chosen-path destination" key={d}>
                    <span className="dest-number">0{i + 1}</span>
                    <HardDrive size={23} />
                    <div>
                      <strong>{leaf(d)}</strong>
                      <span title={d}>{d}</span>
                    </div>
                    <Button
                      kind="icon"
                      title={`移除目的地 ${leaf(d)}`}
                      onClick={() =>
                        setDests((all) => all.filter((p) => p !== d))
                      }
                    >
                      <X size={15} />
                    </Button>
                  </div>
                ))}
                {dests.length < 4 && (
                  <>
                    <button
                      className={`add-destination ${draggingDestination ? "dragging" : ""}`}
                      disabled={busy}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDraggingDestination(true);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                        setDraggingDestination(true);
                      }}
                      onDragLeave={() => setDraggingDestination(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDraggingDestination(false);
                        const paths = api.resolveDroppedPaths([
                          ...event.dataTransfer.files,
                        ]);
                        if (!paths.length) {
                          setError("请从 Finder 拖入一个目的地文件夹");
                          return;
                        }
                        for (const dropped of paths.slice(0, 4 - dests.length))
                          addDest(dropped);
                      }}
                      onClick={() =>
                        void attempt(async () => {
                          const p = await api.selectDirectory();
                          if (p) addDest(p);
                        })
                      }
                    >
                      <Plus size={20} />
                      <span>
                        {draggingDestination
                          ? "松开以添加目的地"
                          : "添加备份目的地"}
                      </span>
                      <small>点击选择，或从 Finder 直接拖入文件夹</small>
                    </button>
                    <div className="manual-path">
                      <input
                        aria-label="目的地路径"
                        placeholder="或输入目的地绝对路径"
                        value={destInput}
                        onChange={(e) => setDestInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addDest(destInput);
                        }}
                      />
                      <Button
                        kind="icon"
                        title="添加输入的目的地"
                        disabled={!destInput}
                        onClick={() => addDest(destInput)}
                      >
                        <Plus size={17} />
                      </Button>
                    </div>
                  </>
                )}
                {mode === "project" && dests.length > 0 && (
                  <div className="destination-final-paths">
                    <div className="dest-heading">
                      <span>最终保存路径</span>
                      <small>
                        素材卷时间戳随当前时间更新，开始任务时最终确认
                      </small>
                    </div>
                    {dests.flatMap((destination) =>
                      (sources.length ? sources : [{ path: "素材源" }]).map(
                        (source, index) => {
                          const volume = previewVolumeName(index),
                            folder =
                              sources.length > 1
                                ? `${volume}_${leaf(source.path)}`
                                : volume;
                          return (
                            <div key={`${destination}-${source.path}`}>
                              <HardDrive size={15} />
                              <span>
                                <strong>{leaf(destination)}</strong>
                                <small className="mono">
                                  {destination}/{project?.projectFolderName}/
                                  {shootDate.replace(/-/g, "")}/{camera}/
                                  {multiPosition ? `${cameraPosition}/` : ""}
                                  {folder}/
                                </small>
                              </span>
                            </div>
                          );
                        },
                      ),
                    )}
                  </div>
                )}
                <div className="notice">
                  <ShieldCheck size={17} />
                  源与目标不能相同或互相包含。应用不会覆盖或删除已有素材。
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <div className="form-section-title">
                  <h3>最后确认，准备出发。</h3>
                  <p>所有副本都会独立回读校验，完成后可导出报告。</p>
                </div>
                <label>
                  {mode === "project"
                    ? "素材卷前缀（可选覆盖项目默认值）"
                    : "任务名称"}
                  <input
                    aria-label="任务名称"
                    placeholder={
                      mode === "project" && project
                        ? `${project.volumePrefixByDevice?.[camera] || project.volumePrefix || `${camera}_`}${previewVolumeTimestamp()}`
                        : sources.length === 1
                          ? leaf(sources[0].path)
                          : "默认使用各素材源文件夹名称"
                    }
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <div className="form-grid">
                  <label>
                    哈希算法
                    <select
                      aria-label="任务哈希算法"
                      value={algorithm}
                      onChange={(e) =>
                        setAlgorithm(e.target.value as Settings["defaultHash"])
                      }
                    >
                      <option value="sha256">SHA-256（推荐）</option>
                      <option value="md5">MD5</option>
                      <option value="sha1">SHA-1</option>
                    </select>
                  </label>
                  <label>
                    同名文件处理
                    <select
                      aria-label="任务同名文件处理"
                      value={duplicate}
                      onChange={(e) =>
                        setDuplicate(e.target.value as "skip" | "suffix")
                      }
                    >
                      <option value="skip">哈希一致时跳过</option>
                      <option value="suffix">内容不同时创建副本</option>
                    </select>
                  </label>
                </div>
                <div className="option-checks">
                  {mode === "card" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={mirror}
                        onChange={(event) => setMirror(event.target.checked)}
                      />
                      <span>
                        镜像备份
                        <small>
                          直接把源目录结构原封不动复制到目的地，不创建素材卷名称与时间戳文件夹
                        </small>
                      </span>
                    </label>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={priority}
                      onChange={(e) => setPriority(e.target.checked)}
                    />
                    <span>
                      优先执行
                      <small>排在其他等待任务之前，不打断当前任务</small>
                    </span>
                  </label>
                  <div className="locked-option">
                    <ShieldCheck size={17} />
                    <span>
                      逐文件哈希校验已开启
                      <small>已存在的文件也会进行完整哈希比对</small>
                    </span>
                  </div>
                  <small className="muted">
                    隐藏文件：{hidden ? "包含" : "排除"}
                    （跟随偏好设置）；系统索引文件始终排除。
                  </small>
                </div>
                <div className="path-preview">
                  <span>
                    {mode === "project"
                      ? "开始备份后的完整路径"
                      : "目的地目录预览"}
                  </span>
                  {mode === "project" ? (
                    <div className="final-path-list">
                      {dests.flatMap((destination) =>
                        (sources.length ? sources : [{ path: "素材源" }]).map(
                          (source, index) => {
                            const volumeName = previewVolumeName(index);
                            const folder =
                              sources.length > 1
                                ? `${volumeName}_${leaf(source.path)}`
                                : volumeName;
                            return (
                              <p
                                className="mono"
                                key={`${destination}-${source.path}`}
                              >
                                {destination}/
                                {project?.projectFolderName ||
                                  `${(project?.shootingDateStart || "").replace(/-/g, "")}_${project?.name}`}
                                /{shootDate.replace(/-/g, "")}/{camera}/
                                {multiPosition ? `${cameraPosition}/` : ""}
                                {folder}/
                              </p>
                            );
                          },
                        ),
                      )}
                    </div>
                  ) : (
                    dests.map((destination) => (
                      <p className="mono" key={destination}>
                        {mirror
                          ? `${destination}/（原目录结构）`
                          : `${destination}/${sources.length === 1 ? leaf(sources[0].path) : "[素材源卷名]"}_[时间戳]/`}
                      </p>
                    ))
                  )}
                  {mode === "project" && (
                    <small className="muted">
                      时间码在点击“开始备份”时按本机时间生成。
                    </small>
                  )}
                </div>
                <div className="readiness-panel">
                  <div className="dest-heading">
                    <span>开始前就绪检查</span>
                    <small>所有关键条件会在引擎预检时再次确认</small>
                  </div>
                  <div className="readiness-grid">
                    <div
                      className={
                        sources.every((source) =>
                          Boolean(source.scan?.totalFiles),
                        )
                          ? "ready"
                          : "warning"
                      }
                    >
                      <Check size={15} />
                      <span>
                        <strong>素材来源</strong>
                        <small>
                          {sources.length} 个来源 ·{" "}
                          {sources.reduce(
                            (sum, source) =>
                              sum + (source.scan?.totalFiles || 0),
                            0,
                          )}{" "}
                          个文件
                        </small>
                      </span>
                    </div>
                    <div
                      className={
                        dests.every(
                          (destination) =>
                            spaces[destination] === undefined ||
                            spaces[destination] >= total,
                        )
                          ? "ready"
                          : "warning"
                      }
                    >
                      <Check size={15} />
                      <span>
                        <strong>目标空间</strong>
                        <small>{dests.length} 个目的地已通过容量检查</small>
                      </span>
                    </div>
                    <div
                      className={
                        new Set(
                          dests
                            .map(
                              (destination) =>
                                volumes.find(
                                  (volume) =>
                                    destination === volume.path ||
                                    destination.startsWith(`${volume.path}/`),
                                )?.identity?.id,
                            )
                            .filter(Boolean),
                        ).size === dests.length
                          ? "ready"
                          : "warning"
                      }
                    >
                      {new Set(
                        dests
                          .map(
                            (destination) =>
                              volumes.find(
                                (volume) =>
                                  destination === volume.path ||
                                  destination.startsWith(`${volume.path}/`),
                              )?.identity?.id,
                          )
                          .filter(Boolean),
                      ).size === dests.length ? (
                        <Check size={15} />
                      ) : (
                        <AlertTriangle size={15} />
                      )}
                      <span>
                        <strong>物理磁盘</strong>
                        <small>
                          {dests.length > 1
                            ? "项目副本必须位于不同物理盘"
                            : "当前只有一个副本"}
                        </small>
                      </span>
                    </div>
                    <div
                      className={
                        mode !== "project" || (project && shootDate && camera)
                          ? "ready"
                          : "warning"
                      }
                    >
                      <Check size={15} />
                      <span>
                        <strong>项目归档</strong>
                        <small>
                          {mode === "project"
                            ? `${shootDate.replace(/-/g, "")} · ${camera}${multiPosition ? ` · ${cameraPosition}` : ""}`
                            : "素材卡独立备份"}
                        </small>
                      </span>
                    </div>
                  </div>
                </div>
                {dests.length === 1 && (
                  <div className="notice amber">
                    <AlertTriangle size={16} />
                    当前只有一个备份目的地。重要素材建议再保存一份独立副本。
                  </div>
                )}
              </>
            )}
            {error && (
              <div role="alert" className="error-box">
                <AlertTriangle size={17} />
                {error}
              </div>
            )}
          </div>
          <aside className="transfer-summary">
            <div className="summary-heading">
              <ShieldCheck size={19} />
              <span>本次备份</span>
            </div>
            <div className="summary-numbers">
              <strong>{sources.length.toString().padStart(2, "0")}</strong>
              <span>个素材源</span>
              <ArrowRight size={19} />
              <strong>{dests.length.toString().padStart(2, "0")}</strong>
              <span>个目的地</span>
            </div>
            <hr />
            <dl>
              <div>
                <dt>工作流</dt>
                <dd>
                  {
                    {
                      card: "素材卡备份",
                      project: "项目备份",
                    }[mode]
                  }
                </dd>
              </div>
              <div>
                <dt>素材总量</dt>
                <dd>
                  {sources.some((s) => s.scan) ? bytes(total) : "扫描后显示"}
                </dd>
              </div>
              <div>
                <dt>文件数量</dt>
                <dd>
                  {sources.some((s) => s.scan)
                    ? sources.reduce(
                        (n, s) => n + (s.scan?.totalFiles || 0),
                        0,
                      ) + " 个"
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>完整性校验</dt>
                <dd className="green-text">始终开启</dd>
              </div>
              <div>
                <dt>源文件</dt>
                <dd>只读保护</dd>
              </div>
            </dl>
            {sources.some((s) => s.scan?.skipped) && (
              <div className="small muted">
                排除 {sources.reduce((n, s) => n + (s.scan?.skipped || 0), 0)}{" "}
                项系统或隐藏条目
              </div>
            )}
            <div className="summary-flow">
              <MemoryStick size={19} />
              <div />
              <HardDrive size={19} />
              <div />
              <Check size={19} />
            </div>
            <p className="summary-note">
              先拷贝，再校验。
              <br />
              每一份副本，都有自己的记录。
            </p>
          </aside>
        </div>
        <div className="modal-footer">
          <Button
            kind="subtle"
            disabled={busy}
            onClick={() => (step > 0 ? setStep((s) => s - 1) : onClose())}
          >
            <ChevronLeft size={16} />
            {step > 0 ? "上一步" : "取消"}
          </Button>
          <div className="row">
            <span className="small muted">
              {busy
                ? step === 0
                  ? "正在扫描素材…"
                  : "正在处理…"
                : `第 ${step + 1} 步，共 3 步`}
            </span>
            <Button
              kind="primary"
              disabled={
                busy ||
                (step === 0 &&
                  (!sources.length || (mode === "project" && !project))) ||
                (step === 1 && !dests.length)
              }
              onClick={() => void (step === 2 ? start() : next())}
            >
              {busy ? (
                <LoaderCircle size={16} className="spin" />
              ) : step === 2 ? (
                <Play size={15} />
              ) : null}
              {step === 2 ? "开始备份" : "下一步"}
              {step < 2 && <ArrowRight size={16} />}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
