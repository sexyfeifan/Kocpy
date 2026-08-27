import { useMemo, useState } from "react";
import { X, Plus, FolderOpen, Check, LoaderCircle, Info, Camera, CalendarDays } from "lucide-react";
import { api, previewVolumeTimestamp, today, type ProjectConfig } from "./api";
import { Button } from "./App";

export const DEVICE_SUGGESTIONS = ["FX3", "FX5", "FX6", "A7R5", "A7CR", "ZVE1", "POCKET", "LUNA", "MAVIC"];
const cleanPrefix = (value: string) => value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
const projectFolder = (date: string, name: string) => `${date.replace(/-/g, "")}_${name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}`;

export function ProjectEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Partial<ProjectConfig>;
  onClose: () => void;
  onSave: (p: ProjectConfig) => Promise<void>;
}) {
  const initialDevices = initial.devices?.length ? initial.devices : ["FX3"];
  const [name, setName] = useState(initial.name || ""),
    [start, setStart] = useState(initial.shootingDateStart || today()),
    [end, setEnd] = useState(initial.shootingDateEnd || initial.shootingDateStart || today()),
    [devices, setDevices] = useState(initialDevices),
    [prefixes, setPrefixes] = useState<Record<string, string>>(() =>
      Object.fromEntries(initialDevices.map((device) => [device, initial.volumePrefixByDevice?.[device] || (initial.volumePrefix && initialDevices.length === 1 ? initial.volumePrefix : `${device}_`)])),
    ),
    [customDevice, setCustomDevice] = useState(""),
    [dests, setDests] = useState(initial.destinationPaths || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
  }
  async function save() {
    setError("");
    if (!name.trim()) return setError("请输入项目名称");
    if (!start || !end || end < start) return setError("请填写有效的拍摄日期范围");
    if (!devices.length) return setError("请至少选择一个设备或机位");
    if (!dests.length) return setError("请至少添加一个备份根目录");
    setBusy(true);
    try {
      const volumePrefixByDevice = Object.fromEntries(devices.map((device) => {
        const prefix = cleanPrefix(prefixes[device] || `${device}_`);
        return [device, prefix.endsWith("_") ? prefix : `${prefix}_`];
      }));
      await onSave({
        ...initial,
        id: initial.id || crypto.randomUUID(),
        name: name.trim(),
        devices,
        volumePrefix: volumePrefixByDevice[devices[0]],
        volumePrefixByDevice,
        projectFolderName: folderName,
        shootingDateStart: start,
        shootingDateEnd: end,
        destinationPaths: dests,
        status: initial.status || "active",
        createdAt: initial.createdAt || Date.now(),
      });
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
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

          <div className="form-section-title"><h3>02 · 常用设备与素材卷</h3><p>最多保存 10 个设备或机位；素材卷使用自定义前缀和本地时间码。</p></div>
          <div className="device-suggestions">
            {DEVICE_SUGGESTIONS.map((device) => <button key={device} disabled={devices.includes(device) || devices.length >= 10} onClick={() => addDevice(device)}><Camera size={14}/>{device}{devices.includes(device) ? <Check size={12}/> : <Plus size={12}/>}</button>)}
          </div>
          <div className="manual-path"><input value={customDevice} onChange={(e) => setCustomDevice(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addDevice(customDevice); }} placeholder="自定义设备或机位，例如 A机" /><Button kind="icon" title="添加设备" disabled={!customDevice.trim() || devices.length >= 10} onClick={() => addDevice(customDevice)}><Plus size={16}/></Button></div>
          <div className="device-profile-list">
            {devices.map((device) => <div className="device-profile" key={device}><span><Camera size={16}/><strong>{device}</strong></span><label>素材卷前缀<input aria-label={`${device} 素材卷前缀`} value={prefixes[device] || ""} onChange={(e) => setPrefixes((all) => ({ ...all, [device]: e.target.value }))} placeholder={`${device}_`} /></label><small>{cleanPrefix(prefixes[device] || `${device}_`)}{previewVolumeTimestamp()}</small><Button kind="icon" title={`移除 ${device}`} onClick={() => removeDevice(device)}><X size={14}/></Button></div>)}
          </div>

          <div className="form-section-title"><h3>03 · 项目备份根目录</h3><p>每次拷卡会在这些根目录下创建相同的项目层级。</p></div>
          {dests.map((p) => <div className="chosen-path" key={p}><FolderOpen size={18}/><span className="mono path">{p}</span><Button kind="icon" title="移除此目的地" onClick={() => setDests((all) => all.filter((value) => value !== p))}><X size={15}/></Button></div>)}
          {dests.length < 4 && <Button kind="subtle" onClick={() => void api.selectDirectory().then((p) => p && setDests((all) => all.includes(p) ? all : [...all, p])).catch((e) => setError(String(e)))}><Plus size={15}/>添加备份根目录</Button>}
          <div className="notice"><Info size={16}/><span>实际路径示例：<span className="mono">备份根目录/{folderName}/{today().replace(/-/g, "")}/{devices[0] || "设备"}/{cleanPrefix(prefixes[devices[0]] || "Untitled_")}{previewVolumeTimestamp()}/</span></span></div>
          {error && <div role="alert" className="error-box">{error}</div>}
        </div>
        <div className="modal-footer"><Button kind="subtle" onClick={onClose} disabled={busy}>取消</Button><Button kind="primary" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}保存项目</Button></div>
      </section>
    </div>
  );
}
