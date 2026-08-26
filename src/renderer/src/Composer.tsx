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
  Trash2,
  FolderKanban,
  SlidersHorizontal,
  Copy,
  Play,
  AlertTriangle,
} from "lucide-react";
import {
  api,
  bytes,
  leaf,
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
export function Composer({
  initial,
  volumes,
  projects,
  settings,
  onClose,
  onCreated,
}: {
  initial: { source?: string; project?: ProjectConfig };
  volumes: Volume[];
  projects: ProjectConfig[];
  settings: Settings;
  onClose: () => void;
  onCreated: () => Promise<void>;
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
  const [mode, setMode] = useState<"card" | "project" | "mirror">(
      initial.project ? "project" : "card",
    ),
    [projectId, setProjectId] = useState(initial.project?.id || ""),
    [shootDate, setShootDate] = useState(today()),
    [camera, setCamera] = useState(initial.project?.devices[0] || "A机"),
    [name, setName] = useState(""),
    [algorithm, setAlgorithm] = useState(settings.defaultHash),
    [duplicate, setDuplicate] = useState(settings.defaultDuplicateStrategy),
    [hidden, setHidden] = useState(settings.includeHidden),
    [priority, setPriority] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [spaces, setSpaces] = useState<Record<string, number>>({});
  const dialog = useRef<HTMLElement>(null);
  const project = projects.find((p) => p.id === projectId),
    total = sources.reduce((n, s) => n + (s.scan?.totalBytes || 0), 0);
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
        if (mode === "mirror" && sources.length > 1)
          throw new Error("目录备份一次只接受一个源，以避免文件名冲突");
        const scanned: Source[] = [];
        for (const s of sources) {
          const scan = await api.scanSource(s.path, hidden);
          if (!scan.totalFiles)
            throw new Error(`${leaf(s.path)} 没有可备份文件`);
          scanned.push({ ...s, scan });
        }
        setSources(scanned);
        setStep(1);
      } else if (step === 1) {
        if (!dests.length) throw new Error("请添加至少一个目的地");
        if (mode === "project" && !project) throw new Error("请选择拍摄项目");
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
        const claimed = mode === "project" && project ? await api.claimProjectVolume(project.id, camera) : undefined;
        const automaticName = claimed ? `${claimed.prefix}${String(claimed.number).padStart(3, "0")}` : leaf(source.path);
        const taskName = name || automaticName;
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
          shootingDate: mode === "project" ? shootDate : "",
          projectName: mode === "project" ? project?.name : undefined,
          projectId: mode === "project" ? project?.id : undefined,
          copyMode:
            mode === "mirror" ? ("mirror" as const) : ("normal" as const),
          duplicateStrategy: duplicate,
          includeHidden: hidden,
          priority,
          volumeNumber: claimed?.number,
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
      setCamera(p.devices[0] || "A机");
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
                      "按项目 / 日期 / 机位整理",
                      FolderKanban,
                    ],
                    ["mirror", "目录备份", "直接保留相对目录结构", Copy],
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
                  <p>支持素材卡、硬盘目录；可添加多个素材源</p>
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
                {volumes.some((v) => v.deviceType === "source") && (
                  <div className="detected">
                    <span>已检测素材介质</span>
                    {volumes
                      .filter((v) => v.deviceType === "source")
                      .map((v) => (
                        <button
                          key={v.path}
                          disabled={busy}
                          onClick={() => addSource(v.path)}
                        >
                          <MemoryStick size={15} />
                          {v.name}
                          <Plus size={13} />
                        </button>
                      ))}
                  </div>
                )}
                {mode === "mirror" && (
                  <div className="notice">
                    <Info size={15} />
                    目录备份不会删除目的地额外文件，不是破坏性的同步镜像。
                  </div>
                )}
              </>
            )}
            {step === 1 && (
              <>
                <div className="form-section-title">
                  <h3>把副本，放在可靠的地方。</h3>
                  <p>最多添加 4 个目的地。建议使用不同物理磁盘。</p>
                </div>
                {mode === "project" && (
                  <div className="project-form">
                    <label>
                      关联拍摄项目
                      <select
                        aria-label="关联拍摄项目"
                        value={projectId}
                        onChange={(e) => chooseProject(e.target.value)}
                      >
                        <option value="">请选择项目</option>
                        {projects
                          .filter((p) => p.status !== "archived")
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <div className="form-grid">
                      <label>
                        拍摄日期
                        <input
                          type="date"
                          value={shootDate}
                          onChange={(e) => setShootDate(e.target.value)}
                          required
                        />
                      </label>
                      <label>
                        机位
                        <select
                          value={camera}
                          onChange={(e) => setCamera(e.target.value)}
                        >
                          {(project?.devices.length
                            ? project.devices
                            : ["A机"]
                          ).map((d) => (
                            <option key={d}>{d}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {!projects.length && (
                      <div className="notice">
                        请先关闭此窗口，在「拍摄项目」创建一个项目，或切换到素材卡备份。
                      </div>
                    )}
                  </div>
                )}
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
                      className="add-destination"
                      disabled={busy}
                      onClick={() =>
                        void attempt(async () => {
                          const p = await api.selectDirectory();
                          if (p) addDest(p);
                        })
                      }
                    >
                      <Plus size={20} />
                      <span>添加备份目的地</span>
                      <small>本地磁盘、移动硬盘或已挂载 NAS</small>
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
                  任务名称 / 卷标前缀
                  <input
                    aria-label="任务名称"
                    placeholder={
                      mode === "project" && project
                        ? `${project.volumePrefix || camera}${String(project.nextVolumeByDevice?.[camera] || 1).padStart(3, "0")}（确认开始后占用此卷号）`
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
                  <span>目的地目录预览</span>
                  {dests.map((d) => (
                    <p className="mono" key={d}>
                      {d}
                      {mode === "mirror"
                        ? "/[原始目录结构]"
                        : `/${mode === "project" ? `${project?.name}/${shootDate}/${camera}/` : ""}${name || (mode === "project" && project ? `${project.volumePrefix || camera}${String(project.nextVolumeByDevice?.[camera] || 1).padStart(3, "0")}` : "[素材源名称]")}_[时间戳]_[唯一标识]/`}
                    </p>
                  ))}
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
                      mirror: "目录备份",
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
                (step === 0 && !sources.length) ||
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
