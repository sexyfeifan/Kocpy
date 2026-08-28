import { useMemo, useState } from "react";
import { X, Plus, FolderOpen, Check, LoaderCircle, Info, Camera, CalendarDays } from "lucide-react";
import { api, previewVolumeTimestamp, today, type ProjectConfig, type ProjectStructureReport } from "./api";
import { Button } from "./App";

export const DEVICE_SUGGESTIONS = ["FX3", "FX5", "FX6", "A7R5", "A7CR", "ZVE1", "POCKET", "LUNA", "MAVIC"];
const CAMERA_POSITIONS = ["A", "B", "C", "D", "E"];
const cleanPrefix = (value: string) => value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
const projectFolder = (date: string, name: string) => `${date.replace(/-/g, "")}_${name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}`;

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
    [end, setEnd] = useState(initial.shootingDateEnd || initial.shootingDateStart || today()),
    [devices, setDevices] = useState(initialDevices),
    [prefixes, setPrefixes] = useState<Record<string, string>>(() =>
      Object.fromEntries(initialDevices.map((device) => [device, initial.volumePrefixByDevice?.[device] || (initial.volumePrefix && initialDevices.length === 1 ? initial.volumePrefix : `${device}_`)])),
    ),
    [positions, setPositions] = useState<Record<string, string[]>>(() => initial.devicePositions || {}),
    [requiredCopies, setRequiredCopies] = useState(initial.requiredCopies || 2),
    [customDevice, setCustomDevice] = useState(""),
    [dests, setDests] = useState(initial.destinationPaths || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState<{ project: ProjectConfig; report: ProjectStructureReport } | null>(null);
  const folderName = useMemo(() => projectFolder(start, name || "项目名"), [start, name]);

  function addDevice(raw: string) {
    const device = raw.trim();
    if (!device || devices.includes(device)) return;
    if (devices.length >= 10) return setError("一个项目最多保留 10 个常用设备或机位");
    setDevices((all) => [...all, device]);
    setPrefixes((all) => ({ ...all, [device]: `${device}_` }));
    setCustomDevice("");
    setError("");
  }
  function removeDevice(device: string) {
    setDevices((all) => all.filter((value) => value !== device));
    setPrefixes((all) => { const next = { ...all }; delete next[device]; return next; });
    setPositions((all) => { const next = { ...all }; delete next[device]; return next; });
  }
  function setMultiPosition(device: string, enabled: boolean) {
    setPositions((all) => ({ ...all, [device]: enabled ? (all[device]?.length ? all[device] : CAMERA_POSITIONS.slice(0, 2)) : [] }));
  }
  function setPositionCount(device: string, count: number) {
    setPositions((all) => ({ ...all, [device]: CAMERA_POSITIONS.slice(0, count) }));
  }
  function buildProject(): ProjectConfig | undefined {
    if (!name.trim()) { setError("请输入项目名称"); return; }
    if (!start || !end || end < start) { setError("请填写有效的拍摄日期范围"); return; }
    if (!devices.length) { setError("请至少选择一个设备或机位"); return; }
    if (!dests.length) { setError("请至少添加一个备份根目录"); return; }
    const volumePrefixByDevice = Object.fromEntries(devices.map((device) => {
      const prefix = cleanPrefix(prefixes[device] || `${device}_`);
      return [device, prefix.endsWith("_") ? prefix : `${prefix}_`];
    }));
    return {
        ...initial,
        id: initial.id || crypto.randomUUID(),
        name: name.trim(),
        devices,
        volumePrefix: volumePrefixByDevice[devices[0]],
        volumePrefixByDevice,
        devicePositions: Object.fromEntries(devices.flatMap((device) => positions[device]?.length ? [[device, positions[device]]] : [])),
        projectFolderName: folderName,
        shootingDateStart: start,
        shootingDateEnd: end,
        destinationPaths: dests,
        requiredCopies,
        status: initial.status || "active",
        createdAt: initial.createdAt || Date.now(),
    };
  }
  async function commit(project: ProjectConfig, createMissing: boolean) {
    setBusy(true); setError("");
    try {
      await onSave(project, createMissing);
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setError(""); setReview(null);
    const project = buildProject();
    if (!project) return;
    if (!initial.id) return commit(project, true);
    setBusy(true);
    try {
      const report = await api.inspectProjectStructure(project);
      const needsReview = report.missingCount || report.conflictCount || report.destinations.some((item) => item.error);
      if (needsReview) setReview({ project, report });
      else await onSave(project, false);
    } catch (e) { setError(String(e).replace(/^Error: /, "")); }
    finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop top-layer">
      <section className="form-modal project-editor-modal" role="dialog" aria-modal="true" aria-label={initial.id ? "编辑项目" : "新建项目"}>
        <div className="modal-header">
          <div><span className="eyebrow">PRODUCTION PROJECT</span><h2>{initial.id ? "编辑拍摄项目" : "建立拍摄项目"}</h2></div>
          <Button kind="icon" title="关闭项目编辑" disabled={busy} onClick={onClose}><X size={20} /></Button>
        </div>
        <div className="form-body">
          <div className="form-section-title"><h3>01 · 项目与拍摄周期</h3><p>项目根目录由开始日期和项目名称自动生成。</p></div>
          <label>项目名称<input autoFocus aria-label="项目名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：山海之间品牌短片" /></label>
          <div className="form-grid">
            <label>项目开始日期<input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label>预计结束日期<input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
          <div className="project-path-preview"><CalendarDays size={17}/><div><span>项目文件夹</span><strong className="mono">{folderName}</strong></div></div>

          <div className="form-section-title"><h3>02 · 常用设备与素材卷</h3><p>最多保存 10 个设备；同型号多机位可按 A–E 增加一层机位目录。</p></div>
          <div className="device-suggestions">
            {DEVICE_SUGGESTIONS.map((device) => <button key={device} disabled={devices.includes(device) || devices.length >= 10} onClick={() => addDevice(device)}><Camera size={14}/>{device}{devices.includes(device) ? <Check size={12}/> : <Plus size={12}/>}</button>)}
          </div>
          <div className="manual-path"><input value={customDevice} onChange={(e) => setCustomDevice(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addDevice(customDevice); }} placeholder="自定义设备或机位，例如 A机" /><Button kind="icon" title="添加设备" disabled={!customDevice.trim() || devices.length >= 10} onClick={() => addDevice(customDevice)}><Plus size={16}/></Button></div>
          <div className="device-profile-list">
            {devices.map((device) => <div className="device-profile-card" key={device}><div className="device-profile"><span><Camera size={16}/><strong>{device}</strong></span><label>素材卷前缀<input aria-label={`${device} 素材卷前缀`} value={prefixes[device] || ""} onChange={(e) => setPrefixes((all) => ({ ...all, [device]: e.target.value }))} placeholder={`${device}_`} /></label><small>{cleanPrefix(prefixes[device] || `${device}_`)}{previewVolumeTimestamp()}</small><Button kind="icon" title={`移除 ${device}`} onClick={() => removeDevice(device)}><X size={14}/></Button></div><div className="position-config"><label><input type="checkbox" checked={Boolean(positions[device]?.length)} onChange={(e) => setMultiPosition(device, e.target.checked)}/><span>同型号多机位</span></label>{positions[device]?.length ? <><label>机位数量<select aria-label={`${device} 机位数量`} value={positions[device].length} onChange={(e) => setPositionCount(device, Number(e.target.value))}>{[2,3,4,5].map((count) => <option key={count} value={count}>{count} 个（{CAMERA_POSITIONS.slice(0,count).join(" / ")}）</option>)}</select></label><small className="mono">设备/{positions[device].join("、")}/素材卷</small></> : <small>关闭时路径直接进入素材卷，不增加机位层级</small>}</div></div>)}
          </div>

          <div className="form-section-title"><h3>03 · 项目备份根目录</h3><p>每次拷卡会在这些根目录下创建相同的项目层级。</p></div>
          <label>项目要求的安全副本数量<select value={requiredCopies} onChange={(event) => setRequiredCopies(Number(event.target.value))}>{[1,2,3,4].map((count) => <option key={count} value={count}>{count} 份物理独立校验副本</option>)}</select></label>
          {dests.map((p) => <div className="chosen-path" key={p}><FolderOpen size={18}/><span className="mono path">{p}</span><Button kind="icon" title="移除此目的地" onClick={() => setDests((all) => all.filter((value) => value !== p))}><X size={15}/></Button></div>)}
          {dests.length < 4 && <Button kind="subtle" onClick={() => void api.selectDirectory().then((p) => p && setDests((all) => all.includes(p) ? all : [...all, p])).catch((e) => setError(String(e)))}><Plus size={15}/>添加备份根目录</Button>}
          <div className="notice"><Info size={16}/><span>新项目保存后会按整个拍摄日期范围、设备及 A–E 机位创建完整目录结构。<br/>备份路径示例：<span className="mono">备份根目录/{folderName}/{start.replace(/-/g, "")}/{devices[0] || "设备"}/{positions[devices[0]]?.[0] ? `${positions[devices[0]][0]}/` : ""}{cleanPrefix(prefixes[devices[0]] || "Untitled_")}{previewVolumeTimestamp()}/</span></span></div>
          {review && <div className="structure-review"><div className="structure-review-title"><Info size={17}/><div><strong>检测到项目目录需要处理</strong><span>缺少 {review.report.missingCount} 个目录 · 冲突 {review.report.conflictCount} 项</span></div></div>{review.report.destinations.map((item) => <div className="structure-review-row" key={item.destination}><strong>{item.destination}</strong><span>{item.error ? `无法检查：${item.error}` : `已存在 ${item.existingCount} / ${item.expectedCount} · 缺少 ${item.missing.length}${item.conflicts.length ? ` · 冲突 ${item.conflicts.length}` : ""}`}</span></div>)}<p>补齐操作只创建缺失文件夹，不移动、覆盖或删除已有素材。</p><div className="row"><Button kind="primary" disabled={busy || review.report.conflictCount > 0 || review.report.destinations.some((item) => Boolean(item.error))} onClick={() => void commit(review.project, true)}><FolderOpen size={15}/>创建缺失目录并保存</Button><Button kind="subtle" disabled={busy} onClick={() => void commit(review.project, false)}>仅保存设置</Button><Button kind="subtle" disabled={busy} onClick={() => setReview(null)}>返回检查</Button></div></div>}
          {error && <div role="alert" className="error-box">{error}</div>}
        </div>
        <div className="modal-footer"><Button kind="subtle" onClick={onClose} disabled={busy}>取消</Button><Button kind="primary" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}保存项目</Button></div>
      </section>
    </div>
  );
}
