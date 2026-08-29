import { useMemo, useState } from "react";
import {
  X,
  Plus,
  FolderOpen,
  Check,
  LoaderCircle,
  Info,
  Camera,
  CalendarDays,
} from "lucide-react";
import {
  api,
  previewVolumeTimestamp,
  today,
  type ProjectConfig,
  type ProjectStructureReport,
} from "./api";
import { Button } from "./App";

export const DEVICE_SUGGESTIONS = [
  "FX3",
  "FX5",
  "FX6",
  "A7R5",
  "A7CR",
  "ZVE1",
  "POCKET",
  "LUNA",
  "MAVIC",
];
const CAMERA_POSITIONS = ["A", "B", "C", "D", "E"];
const cleanPrefix = (value: string) =>
  value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
const projectFolder = (date: string, name: string) =>
  `${date.replace(/-/g, "")}_${name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}`;

export function ProjectEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Partial<ProjectConfig>;
  onClose: () => void;
  onSave: (p: ProjectConfig, createMissing?: boolean) => Promise<void>;
}) {
  const initialDevices = initial.devices?.length ? initial.devices : ["FX3"];
  const [name, setName] = useState(initial.name || ""),
    [start, setStart] = useState(initial.shootingDateStart || today()),
    [end, setEnd] = useState(
      initial.shootingDateEnd || initial.shootingDateStart || today(),
    ),
    [devices, setDevices] = useState(initialDevices),
    [prefixes, setPrefixes] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        initialDevices.map((device) => [
          device,
          initial.volumePrefixByDevice?.[device] ||
            (initial.volumePrefix && initialDevices.length === 1
              ? initial.volumePrefix
              : `${device}_`),
        ]),
      ),
    ),
    [positions, setPositions] = useState<Record<string, string[]>>(
      () => initial.devicePositions || {},
    ),
    [requiredCopies, setRequiredCopies] = useState(initial.requiredCopies || 2),
    [productionType, setProductionType] = useState<
      ProjectConfig["productionType"]
    >(initial.productionType || "custom"),
    [expectedVolumes, setExpectedVolumes] = useState(
      initial.expectedVolumes || 0,
    ),
    [managedSince, setManagedSince] = useState(
      initial.managedSince || initial.shootingDateStart || today(),
    ),
    [namingRule, setNamingRule] = useState(
      initial.namingRule ||
        "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
    ),
    [checklistText, setChecklistText] = useState(
      (initial.checklists || [])
        .map(
          (item) => `${item.phase === "start" ? "开工" : "收工"}:${item.label}`,
        )
        .join("\n"),
    ),
    [completionActions, setCompletionActions] = useState<
      Array<"report" | "delivery" | "proxy" | "eject">
    >(initial.completionActions || ["report"]),
    [crewText, setCrewText] = useState(
      (initial.crew || [])
        .map((item) => `${item.role}:${item.name}`)
        .join("\n"),
    ),
    [customDevice, setCustomDevice] = useState(""),
    [dests, setDests] = useState(initial.destinationPaths || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState<{
      project: ProjectConfig;
      report: ProjectStructureReport;
    } | null>(null);
  const folderName = useMemo(
    () => projectFolder(start, name || "项目名"),
    [start, name],
  );

  function addDevice(raw: string) {
    const device = raw.trim();
    if (!device || devices.includes(device)) return;
    if (devices.length >= 10)
      return setError("一个项目最多保留 10 个常用设备或机位");
    setDevices((all) => [...all, device]);
    setPrefixes((all) => ({ ...all, [device]: `${device}_` }));
    setCustomDevice("");
    setError("");
  }
  function removeDevice(device: string) {
    setDevices((all) => all.filter((value) => value !== device));
    setPrefixes((all) => {
      const next = { ...all };
      delete next[device];
      return next;
    });
    setPositions((all) => {
      const next = { ...all };
      delete next[device];
      return next;
    });
  }
  function setMultiPosition(device: string, enabled: boolean) {
    setPositions((all) => ({
      ...all,
      [device]: enabled
        ? all[device]?.length
          ? all[device]
          : CAMERA_POSITIONS.slice(0, 2)
        : [],
    }));
  }
  function setPositionCount(device: string, count: number) {
    setPositions((all) => ({
      ...all,
      [device]: CAMERA_POSITIONS.slice(0, count),
    }));
  }
  function buildProject(): ProjectConfig | undefined {
    if (!name.trim()) {
      setError("请输入项目名称");
      return;
    }
    if (!start || !end || end < start) {
      setError("请填写有效的拍摄日期范围");
      return;
    }
    if (!devices.length) {
      setError("请至少选择一个设备或机位");
      return;
    }
    if (!dests.length) {
      setError("请至少添加一个备份根目录");
      return;
    }
    const unknown = [...namingRule.matchAll(/\{([^}]+)\}/g)]
      .map((item) => item[1])
      .filter(
        (item) =>
          ![
            "date",
            "project",
            "shootingDate",
            "device",
            "position",
            "card",
          ].includes(item),
      );
    if (unknown.length || !namingRule.includes("{card}")) {
      setError(
        unknown.length
          ? `命名规则包含未知变量：${unknown.join("、")}`
          : "命名规则必须包含 {card}",
      );
      return;
    }
    const volumePrefixByDevice = Object.fromEntries(
      devices.map((device) => {
        const prefix = cleanPrefix(prefixes[device] || `${device}_`);
        return [device, prefix.endsWith("_") ? prefix : `${prefix}_`];
      }),
    );
    return {
      ...initial,
      id: initial.id || crypto.randomUUID(),
      name: name.trim(),
      devices,
      volumePrefix: volumePrefixByDevice[devices[0]],
      volumePrefixByDevice,
      devicePositions: Object.fromEntries(
        devices.flatMap((device) =>
          positions[device]?.length ? [[device, positions[device]]] : [],
        ),
      ),
      projectFolderName: folderName,
      shootingDateStart: start,
      shootingDateEnd: end,
      destinationPaths: dests,
      requiredCopies,
      productionType,
      expectedVolumes: expectedVolumes || undefined,
      managedSince,
      crew: crewText
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [role, ...name] = line.split(":");
          return {
            id: crypto.randomUUID(),
            role: ([
              "DIT",
              "cinematographer",
              "data-manager",
              "assistant",
            ].includes(role)
              ? role
              : "other") as
              | "DIT"
              | "cinematographer"
              | "data-manager"
              | "assistant"
              | "other",
            name: (name.join(":") || role).trim(),
          };
        }),
      namingRule,
      checklists: checklistText.trim()
        ? checklistText
            .split(/\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line, index) => {
              const [phase, ...label] = line.split(":");
              return {
                id: `custom-${index}-${crypto.randomUUID()}`,
                phase:
                  phase === "开工" ? ("start" as const) : ("close" as const),
                label: (label.join(":") || phase).trim(),
                required: true,
              };
            })
        : [
            {
              id: "start-media",
              phase: "start",
              label: "确认素材卡、项目、日期与摄影机",
              required: true,
            },
            {
              id: "start-destinations",
              phase: "start",
              label: "确认目的地位于独立物理磁盘",
              required: true,
            },
            {
              id: "close-verified",
              phase: "close",
              label: "所有素材卷达到独立副本要求",
              required: true,
            },
            {
              id: "close-report",
              phase: "close",
              label: "报告与交接记录已经生成",
              required: true,
            },
            {
              id: "close-eject",
              phase: "close",
              label: "合格设备已安全推出",
              required: true,
            },
          ],
      completionActions,
      status: initial.status || "active",
      createdAt: initial.createdAt || Date.now(),
    };
  }
  async function commit(project: ProjectConfig, createMissing: boolean) {
    setBusy(true);
    setError("");
    try {
      await onSave(project, createMissing);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setError("");
    setReview(null);
    const project = buildProject();
    if (!project) return;
    if (!initial.id) return commit(project, true);
    setBusy(true);
    try {
      const report = await api.inspectProjectStructure(project);
      const needsReview =
        report.missingCount ||
        report.conflictCount ||
        report.destinations.some((item) => item.error);
      if (needsReview) setReview({ project, report });
      else await onSave(project, false);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal project-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={initial.id ? "编辑项目" : "新建项目"}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">PRODUCTION PROJECT</span>
            <h2>{initial.id ? "编辑拍摄项目" : "建立拍摄项目"}</h2>
          </div>
          <Button
            kind="icon"
            title="关闭项目编辑"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </Button>
        </div>
        <div className="form-body">
          <div className="form-section-title">
            <h3>01 · 项目与拍摄周期</h3>
            <p>项目根目录由开始日期和项目名称自动生成。</p>
          </div>
          <label>
            项目名称
            <input
              autoFocus
              aria-label="项目名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：山海之间品牌短片"
            />
          </label>
          <div className="form-grid">
            <label>
              项目开始日期
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              预计结束日期
              <input
                type="date"
                value={end}
                min={start}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <div className="project-path-preview">
            <CalendarDays size={17} />
            <div>
              <span>项目文件夹</span>
              <strong className="mono">{folderName}</strong>
            </div>
          </div>
          <div className="form-grid">
            <label>
              制作类型
              <select
                value={productionType}
                onChange={(e) =>
                  setProductionType(
                    e.target.value as ProjectConfig["productionType"],
                  )
                }
              >
                <option value="commercial">广告</option>
                <option value="documentary">纪录片</option>
                <option value="short">短片</option>
                <option value="variety">综艺</option>
                <option value="feature">电影</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            <label>
              预计素材卷数量
              <input
                type="number"
                min="0"
                value={expectedVolumes}
                onChange={(e) =>
                  setExpectedVolumes(Math.max(0, Number(e.target.value)))
                }
              />
              <small>未知时填 0，不显示误导性的项目百分比。</small>
            </label>
          </div>
          <label>
            Kocpy 管理起始日期
            <input
              type="date"
              value={managedSince}
              onChange={(e) => setManagedSince(e.target.value)}
            />
            <small>中途接管项目时，用于明确 Kocpy 覆盖范围。</small>
          </label>
          <label>
            项目目录命名规则
            <input
              value={namingRule}
              onChange={(e) => setNamingRule(e.target.value)}
              placeholder="{date}_{project}/{shootingDate}/{device}/{position}/{card}"
            />
            <small>
              支持 {"{date}"}、{"{project}"}、{"{shootingDate}"}、{"{device}"}、
              {"{position}"}、{"{card}"}；未配置机位时自动省略空层级。
            </small>
          </label>
          <label>
            自定义开工 / 收工标准
            <textarea
              rows={5}
              value={checklistText}
              onChange={(e) => setChecklistText(e.target.value)}
              placeholder={
                "开工:确认素材卡、项目、日期与摄影机\n开工:确认独立目的地\n收工:所有素材卷达到副本要求\n收工:报告与交接已生成"
              }
            />
            <small>每行以“开工:”或“收工:”开头；空白时使用专业默认标准。</small>
          </label>
          <label>
            制作人员与角色
            <textarea
              rows={4}
              value={crewText}
              onChange={(e) => setCrewText(e.target.value)}
              placeholder={"DIT:张三\ncinematographer:李四\ndata-manager:王五"}
            />
            <small>
              每行使用“角色:姓名”；支持
              DIT、cinematographer、data-manager、assistant。
            </small>
          </label>

          <div className="form-section-title">
            <h3>02 · 常用设备与素材卷</h3>
            <p>最多保存 10 个设备；同型号多机位可按 A–E 增加一层机位目录。</p>
          </div>
          <div className="device-suggestions">
            {DEVICE_SUGGESTIONS.map((device) => (
              <button
                key={device}
                disabled={devices.includes(device) || devices.length >= 10}
                onClick={() => addDevice(device)}
              >
                <Camera size={14} />
                {device}
                {devices.includes(device) ? (
                  <Check size={12} />
                ) : (
                  <Plus size={12} />
                )}
              </button>
            ))}
          </div>
          <div className="manual-path">
            <input
              value={customDevice}
              onChange={(e) => setCustomDevice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addDevice(customDevice);
              }}
              placeholder="自定义设备或机位，例如 A机"
            />
            <Button
              kind="icon"
              title="添加设备"
              disabled={!customDevice.trim() || devices.length >= 10}
              onClick={() => addDevice(customDevice)}
            >
              <Plus size={16} />
            </Button>
          </div>
          <div className="device-profile-list">
            {devices.map((device) => (
              <div className="device-profile-card" key={device}>
                <div className="device-profile">
                  <span>
                    <Camera size={16} />
                    <strong>{device}</strong>
                  </span>
                  <label>
                    素材卷前缀
                    <input
                      aria-label={`${device} 素材卷前缀`}
                      value={prefixes[device] || ""}
                      onChange={(e) =>
                        setPrefixes((all) => ({
                          ...all,
                          [device]: e.target.value,
                        }))
                      }
                      placeholder={`${device}_`}
                    />
                  </label>
                  <small>
                    {cleanPrefix(prefixes[device] || `${device}_`)}
                    {previewVolumeTimestamp()}
                  </small>
                  <Button
                    kind="icon"
                    title={`移除 ${device}`}
                    onClick={() => removeDevice(device)}
                  >
                    <X size={14} />
                  </Button>
                </div>
                <div className="position-config">
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(positions[device]?.length)}
                      onChange={(e) =>
                        setMultiPosition(device, e.target.checked)
                      }
                    />
                    <span>同型号多机位</span>
                  </label>
                  {positions[device]?.length ? (
                    <>
                      <label>
                        机位数量
                        <select
                          aria-label={`${device} 机位数量`}
                          value={positions[device].length}
                          onChange={(e) =>
                            setPositionCount(device, Number(e.target.value))
                          }
                        >
                          {[2, 3, 4, 5].map((count) => (
                            <option key={count} value={count}>
                              {count} 个（
                              {CAMERA_POSITIONS.slice(0, count).join(" / ")}）
                            </option>
                          ))}
                        </select>
                      </label>
                      <small className="mono">
                        设备/{positions[device].join("、")}/素材卷
                      </small>
                    </>
                  ) : (
                    <small>关闭时路径直接进入素材卷，不增加机位层级</small>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="form-section-title">
            <h3>03 · 项目备份根目录</h3>
            <p>每次拷卡会在这些根目录下创建相同的项目层级。</p>
          </div>
          <label>
            项目要求的安全副本数量
            <select
              value={requiredCopies}
              onChange={(event) =>
                setRequiredCopies(Number(event.target.value))
              }
            >
              {[1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count} 份物理独立校验副本
                </option>
              ))}
            </select>
          </label>
          <div className="option-checks">
            <label>
              <input
                type="checkbox"
                checked={completionActions.includes("report")}
                onChange={(e) =>
                  setCompletionActions((all) =>
                    e.target.checked
                      ? [...new Set([...all, "report" as const])]
                      : all.filter((item) => item !== "report"),
                  )
                }
              />
              <span>自动生成报告</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={completionActions.includes("delivery")}
                onChange={(e) =>
                  setCompletionActions((all) =>
                    e.target.checked
                      ? [...new Set([...all, "delivery" as const])]
                      : all.filter((item) => item !== "delivery"),
                  )
                }
              />
              <span>自动生成交付清单</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={completionActions.includes("proxy")}
                onChange={(e) =>
                  setCompletionActions((all) =>
                    e.target.checked
                      ? [...new Set([...all, "proxy" as const])]
                      : all.filter((item) => item !== "proxy"),
                  )
                }
              />
              <span>自动加入代理队列</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={completionActions.includes("eject")}
                onChange={(e) =>
                  setCompletionActions((all) =>
                    e.target.checked
                      ? [...new Set([...all, "eject" as const])]
                      : all.filter((item) => item !== "eject"),
                  )
                }
              />
              <span>达标后安全推出</span>
            </label>
          </div>
          {dests.map((p) => (
            <div className="chosen-path" key={p}>
              <FolderOpen size={18} />
              <span className="mono path">{p}</span>
              <Button
                kind="icon"
                title="移除此目的地"
                onClick={() =>
                  setDests((all) => all.filter((value) => value !== p))
                }
              >
                <X size={15} />
              </Button>
            </div>
          ))}
          {dests.length < 4 && (
            <Button
              kind="subtle"
              onClick={() =>
                void api
                  .selectDirectory()
                  .then(
                    (p) =>
                      p &&
                      setDests((all) => (all.includes(p) ? all : [...all, p])),
                  )
                  .catch((e) => setError(String(e)))
              }
            >
              <Plus size={15} />
              添加备份根目录
            </Button>
          )}
          <div className="notice">
            <Info size={16} />
            <span>
              新项目保存后会按整个拍摄日期范围、设备及 A–E
              机位创建完整目录结构。
              <br />
              备份路径示例：
              <span className="mono">
                备份根目录/{folderName}/{start.replace(/-/g, "")}/
                {devices[0] || "设备"}/
                {positions[devices[0]]?.[0]
                  ? `${positions[devices[0]][0]}/`
                  : ""}
                {cleanPrefix(prefixes[devices[0]] || "Untitled_")}
                {previewVolumeTimestamp()}/
              </span>
            </span>
          </div>
          {review && (
            <div className="structure-review">
              <div className="structure-review-title">
                <Info size={17} />
                <div>
                  <strong>检测到项目目录需要处理</strong>
                  <span>
                    缺少 {review.report.missingCount} 个目录 · 冲突{" "}
                    {review.report.conflictCount} 项
                  </span>
                </div>
              </div>
              {review.report.destinations.map((item) => (
                <div className="structure-review-row" key={item.destination}>
                  <strong>{item.destination}</strong>
                  <span>
                    {item.error
                      ? `无法检查：${item.error}`
                      : `已存在 ${item.existingCount} / ${item.expectedCount} · 缺少 ${item.missing.length}${item.conflicts.length ? ` · 冲突 ${item.conflicts.length}` : ""}`}
                  </span>
                </div>
              ))}
              <p>补齐操作只创建缺失文件夹，不移动、覆盖或删除已有素材。</p>
              <div className="row">
                <Button
                  kind="primary"
                  disabled={
                    busy ||
                    review.report.conflictCount > 0 ||
                    review.report.destinations.some((item) =>
                      Boolean(item.error),
                    )
                  }
                  onClick={() => void commit(review.project, true)}
                >
                  <FolderOpen size={15} />
                  创建缺失目录并保存
                </Button>
                <Button
                  kind="subtle"
                  disabled={busy}
                  onClick={() => void commit(review.project, false)}
                >
                  仅保存设置
                </Button>
                <Button
                  kind="subtle"
                  disabled={busy}
                  onClick={() => setReview(null)}
                >
                  返回检查
                </Button>
              </div>
            </div>
          )}
          {error && (
            <div role="alert" className="error-box">
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button kind="subtle" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button kind="primary" disabled={busy} onClick={() => void save()}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            保存项目
          </Button>
        </div>
      </section>
    </div>
  );
}
