import { previewProjectPath } from "../../common/project-layout";
import { useState } from "react";
import { Check, Copy, Plus, Trash2, X } from "lucide-react";
import { api, type ProjectTemplate } from "./api";
import { Button } from "./App";
import { DEVICE_SUGGESTIONS } from "./ProjectEditor";

const DEFAULT_RULE =
  "{date}_{project}/{shootingDate}/{device}/{position}/{card}";
const ACTIONS = [
  ["report", "自动生成报告"],
  ["delivery", "自动生成交付清单"],
  ["proxy", "自动加入代理队列"],
  ["eject", "达标后安全推出"],
] as const;
type CompletionAction = ProjectTemplate["completionActions"][number];

export function projectTemplateDraft(
  project: import("./api").ProjectConfig,
): Partial<ProjectTemplate> {
  return {
    name: `${project.name} 模板`,
    description: `从项目“${project.name}”复制的制作流程`,
    kind: "custom",
    productionType: project.productionType || "custom",
    devices: [...project.devices],
    volumePrefix: project.volumePrefix,
    volumePrefixByDevice: { ...(project.volumePrefixByDevice || {}) },
    devicePositions: Object.fromEntries(
      Object.entries(project.devicePositions || {}).map(([device, values]) => [
        device,
        [...values],
      ]),
    ),
    requiredCopies: project.requiredCopies || 2,
    namingRule: project.namingRule || DEFAULT_RULE,
    completionActions: [...(project.completionActions || ["report"])],
    expectedVolumes: project.expectedVolumes,
    checklists: project.checklists?.map((item) => ({ ...item })),
    crew: project.crew?.map((item) => ({ ...item })),
  };
}

export function TemplateEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Partial<ProjectTemplate>;
  onClose: () => void;
  onSaved: (templates: ProjectTemplate[]) => void;
}) {
  const initialDevices = initial.devices?.length ? initial.devices : ["A Cam"];
  const [name, setName] = useState(initial.name || ""),
    [description, setDescription] = useState(initial.description || ""),
    [productionType, setProductionType] = useState(
      initial.productionType || "custom",
    ),
    [devices, setDevices] = useState([...initialDevices]),
    [prefixes, setPrefixes] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        initialDevices.map((device) => [
          device,
          initial.volumePrefixByDevice?.[device] ||
            (initialDevices.length === 1
              ? initial.volumePrefix || `${device}_`
              : `${device}_`),
        ]),
      ),
    ),
    [positions, setPositions] = useState<Record<string, string>>(() =>
      Object.fromEntries(
        Object.entries(initial.devicePositions || {}).map(([device, value]) => [
          device,
          value.join(","),
        ]),
      ),
    ),
    [newDevice, setNewDevice] = useState(""),
    [requiredCopies, setRequiredCopies] = useState(initial.requiredCopies || 2),
    [expectedVolumes, setExpectedVolumes] = useState(
      initial.expectedVolumes || 0,
    ),
    [namingRule, setNamingRule] = useState(initial.namingRule || DEFAULT_RULE),
    [actions, setActions] = useState<CompletionAction[]>(
      initial.completionActions || ["report"],
    ),
    [checklistText, setChecklistText] = useState(
      (initial.checklists || [])
        .map(
          (item) => `${item.phase === "start" ? "开工" : "收工"}:${item.label}`,
        )
        .join("\n"),
    ),
    [crewText, setCrewText] = useState(
      (initial.crew || [])
        .map((item) => `${item.role}:${item.name}`)
        .join("\n"),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  const addDevice = (raw: string) => {
    const device = raw.trim();
    if (!device || devices.includes(device)) return;
    if (devices.length >= 10) return setError("模板最多保存 10 个设备");
    setDevices((current) => [...current, device]);
    setPrefixes((current) => ({ ...current, [device]: `${device}_` }));
    setNewDevice("");
    setError("");
  };
  const removeDevice = (device: string) => {
    if (devices.length === 1) return setError("模板至少需要一个设备");
    setDevices((current) => current.filter((item) => item !== device));
    setPrefixes((current) => {
      const next = { ...current };
      delete next[device];
      return next;
    });
    setPositions((current) => {
      const next = { ...current };
      delete next[device];
      return next;
    });
  };
  const toggleAction = (action: CompletionAction, enabled: boolean) =>
    setActions((current) =>
      enabled
        ? [...new Set([...current, action])]
        : current.filter((item) => item !== action),
    );

  const save = async () => {
    setError("");
    if (!name.trim()) return setError("请输入模板名称");
    if (!devices.length) return setError("模板至少需要一个设备");
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
    if (unknown.length || !namingRule.includes("{card}"))
      return setError(
        unknown.length
          ? `命名规则包含未知变量：${unknown.join("、")}`
          : "命名规则必须包含 {card}",
      );
    const checklists = checklistText
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const [phase, ...label] = line.split(":");
          return {
            id: `template-check-${index}-${crypto.randomUUID()}`,
            phase: phase === "开工" ? ("start" as const) : ("close" as const),
            label: (label.join(":") || phase).trim(),
            required: true,
          };
        }),
      crew = crewText
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [role, ...person] = line.split(":");
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
            name: (person.join(":") || role).trim(),
          };
        });
    const template: ProjectTemplate = {
      id: initial.id || `template-${crypto.randomUUID()}`,
      name: name.trim(),
      description: description.trim() || "自定义项目制作流程",
      kind: "custom",
      productionType,
      devices,
      volumePrefix: prefixes[devices[0]] || `${devices[0]}_`,
      volumePrefixByDevice: Object.fromEntries(
        devices.map((device) => [device, prefixes[device] || `${device}_`]),
      ),
      devicePositions: Object.fromEntries(
        devices.flatMap((device) =>
          positions[device]?.trim()
            ? [[device, positions[device].split(/[,，]/)]]
            : [],
        ),
      ),
      requiredCopies,
      namingRule,
      completionActions: actions,
      expectedVolumes: expectedVolumes || undefined,
      checklists,
      crew,
      createdAt: initial.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    setBusy(true);
    try {
      onSaved(await api.saveProjectTemplate(template));
      onClose();
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal template-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-label={initial.id ? "编辑项目模板" : "新建项目模板"}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">PRODUCTION TEMPLATE</span>
            <h2>{initial.id ? "编辑自定义模板" : "建立自定义模板"}</h2>
          </div>
          <Button kind="icon" title="关闭" disabled={busy} onClick={onClose}>
            <X size={19} />
          </Button>
        </div>
        <div className="form-body">
          <div className="form-grid">
            <label>
              模板名称
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：双机位广告三备份"
              />
            </label>
            <label>
              制作类型
              <select
                value={productionType}
                onChange={(event) =>
                  setProductionType(
                    event.target.value as NonNullable<
                      ProjectTemplate["productionType"]
                    >,
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
          </div>
          <label>
            模板说明
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明适用场景、备份策略和交接要求"
            />
          </label>

          <div className="form-section-title">
            <h3>设备、素材卷前缀与机位</h3>
            <p>设备名称、前缀和机位都会随模板应用；最多 10 个设备。</p>
          </div>
          <div className="device-suggestions compact">
            {DEVICE_SUGGESTIONS.map((device) => (
              <button
                key={device}
                disabled={devices.includes(device) || devices.length >= 10}
                onClick={() => addDevice(device)}
              >
                {device}
                {devices.includes(device) ? (
                  <Check size={11} />
                ) : (
                  <Plus size={11} />
                )}
              </button>
            ))}
          </div>
          <div className="manual-path">
            <input
              value={newDevice}
              onChange={(event) => setNewDevice(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addDevice(newDevice);
              }}
              placeholder="自定义设备，例如：录音"
            />
            <Button
              kind="icon"
              title="添加设备"
              onClick={() => addDevice(newDevice)}
            >
              <Plus size={15} />
            </Button>
          </div>
          <div className="template-device-list">
            {devices.map((device) => (
              <div key={device}>
                <strong>{device}</strong>
                <label>
                  素材卷前缀
                  <input
                    value={prefixes[device] || ""}
                    onChange={(event) =>
                      setPrefixes((current) => ({
                        ...current,
                        [device]: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  机位（逗号分隔）
                  <input
                    value={positions[device] || ""}
                    onChange={(event) =>
                      setPositions((current) => ({
                        ...current,
                        [device]: event.target.value,
                      }))
                    }
                    placeholder="A,B"
                  />
                </label>
                <Button
                  kind="icon"
                  title={`移除 ${device}`}
                  onClick={() => removeDevice(device)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>

          <div className="form-grid">
            <label>
              物理独立副本数
              <select
                value={requiredCopies}
                onChange={(event) =>
                  setRequiredCopies(Number(event.target.value))
                }
              >
                {[1, 2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count} 份
                  </option>
                ))}
              </select>
            </label>
            <label>
              预计素材卷数量
              <input
                type="number"
                min="0"
                value={expectedVolumes}
                onChange={(event) =>
                  setExpectedVolumes(Math.max(0, Number(event.target.value)))
                }
              />
            </label>
          </div>
          <label>
            项目目录命名规则
            <input
              value={namingRule}
              onChange={(event) => setNamingRule(event.target.value)}
            />
            <small className="mono">
              {previewProjectPath(namingRule, {
                projectName: "示例项目",
                projectFolderName: "20260831_示例项目",
                projectStartDate: "2026-08-31",
                shootingDate: "2026-09-01",
                device: devices[0] || "FX3",
                position: positions[devices[0]]?.split(/[,，]/)[0],
                card: "素材卷_001",
              })}
            </small>
            <small>
              必须包含 {"{card}"}；不会保存项目名称、日期或磁盘路径。
            </small>
          </label>
          <div className="option-checks">
            {ACTIONS.map(([action, label]) => (
              <label key={action}>
                <input
                  type="checkbox"
                  checked={actions.includes(action)}
                  onChange={(event) =>
                    toggleAction(action, event.target.checked)
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <label>
            开工 / 收工检查表
            <textarea
              rows={5}
              value={checklistText}
              onChange={(event) => setChecklistText(event.target.value)}
              placeholder={
                "开工:确认独立目的地\n收工:全部素材卷副本达标\n收工:交接记录已完成"
              }
            />
            <small>每行使用“开工:”或“收工:”开头。</small>
          </label>
          <label>
            默认制作人员与角色
            <textarea
              rows={4}
              value={crewText}
              onChange={(event) => setCrewText(event.target.value)}
              placeholder={"DIT:姓名\ndata-manager:姓名"}
            />
          </label>
          {error && <div className="error-box">{error}</div>}
        </div>
        <div className="modal-footer">
          <span className="small muted">模板不会保存目的地磁盘路径</span>
          <Button kind="primary" disabled={busy} onClick={() => void save()}>
            <Copy size={15} />
            {busy ? "保存中…" : "保存模板"}
          </Button>
        </div>
      </section>
    </div>
  );
}

export function TemplateApplyDialog({
  template,
  projectName,
  projectId,
  changes,
  onClose,
  onApplied,
}: {
  template: ProjectTemplate;
  projectName: string;
  projectId: string;
  changes: Array<{
    field: string;
    label: string;
    before: string;
    after: string;
  }>;
  onClose: () => void;
  onApplied: (projects: import("./api").ProjectConfig[]) => void;
}) {
  const [selected, setSelected] = useState(changes.map((item) => item.field)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const apply = async () => {
    if (!selected.length) return setError("请至少选择一项要应用的配置");
    setBusy(true);
    setError("");
    try {
      onApplied(
        await api.applyProjectTemplate(template.id, projectId, selected),
      );
      onClose();
    } catch (reason) {
      setError(String(reason).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop top-layer">
      <section
        className="form-modal template-apply-modal"
        role="dialog"
        aria-modal="true"
        aria-label="应用项目模板"
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">APPLY TEMPLATE</span>
            <h2>应用“{template.name}”</h2>
          </div>
          <Button kind="icon" title="关闭" disabled={busy} onClick={onClose}>
            <X size={19} />
          </Button>
        </div>
        <div className="form-body">
          <div className="notice">
            将模板应用到“{projectName}
            ”。项目名称、拍摄日期和目的地路径不会改变。
          </div>
          <div className="template-diff-list">
            {changes.map((change) => (
              <label key={change.field}>
                <input
                  type="checkbox"
                  checked={selected.includes(change.field)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, change.field]
                        : current.filter((field) => field !== change.field),
                    )
                  }
                />
                <span>
                  <strong>{change.label}</strong>
                  <small>当前：{change.before}</small>
                  <small>应用后：{change.after}</small>
                </span>
              </label>
            ))}
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
        <div className="modal-footer">
          <span className="small muted">只覆盖已勾选的配置</span>
          <Button
            kind="primary"
            disabled={busy || !selected.length}
            onClick={() => void apply()}
          >
            <Check size={15} />
            {busy ? "应用中…" : "确认应用"}
          </Button>
        </div>
      </section>
    </div>
  );
}
