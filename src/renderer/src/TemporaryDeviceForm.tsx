import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { projectShootingDates } from "./project-shooting-choice";
import { temporaryDeviceScheduleKey, validateTemporaryDevicePlan } from "../../common/project-day-devices";
import { readableOperationError } from "../../common/interaction";
import { api, type BackupTask, type ProjectConfig } from "./api";
import { Button } from "./Ui";
import "./TemporaryDevice.css";

export function TemporaryDeviceForm({ project, tasks = [], shootingDate, operator, onClose, onSaved, onBusyChange }: {
  project: ProjectConfig;
  tasks?: BackupTask[];
  shootingDate: string;
  operator: string;
  onClose: () => void;
  onSaved: (projects: ProjectConfig[], choice: { shootingDate: string; device: string; position?: string }) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [date, setDate] = useState(shootingDate),
    [device, setDevice] = useState(""),
    [position, setPosition] = useState(""),
    [actualOperator, setActualOperator] = useState(operator),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const saving = useRef(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.scrollIntoView({ block: "nearest" }); }, []);
  const historicDevices = [...new Set([
    ...project.devices,
    ...Object.values(project.expectedDevicesByDate || {}).flat().map((key) => key.split("::")[0]),
  ])];
  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      if (!projectShootingDates(project, tasks).includes(date)) throw new Error("请选择项目内有效的拍摄归属日");
      const scheduleKey = validateTemporaryDevicePlan(project, date, temporaryDeviceScheduleKey(device, position));
      if (!actualOperator.trim()) throw new Error("请填写本次添加设备的实际操作人");
      const updated = await api.updateProjectDailyPlan(project.id, {
        date,
        scheduleKey,
        decision: "expected",
        operator: actualOperator.trim(),
        purpose: "temporary-device",
        note: "通过拍摄日备份流程添加临时设备，仅用于所选拍摄归属日；首次备份时创建目录",
      });
      const [savedDevice, savedPosition] = scheduleKey.split("::");
      onSaved(updated, { shootingDate: date, device: savedDevice, position: savedPosition });
    } catch (cause) {
      setError(readableOperationError(cause));
    } finally {
      saving.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return <section ref={panel} className="temporary-device-form" aria-label="添加该拍摄日临时设备">
    <div className="temporary-device-heading">
      <div><strong>添加该拍摄日临时设备</strong><p>可选择项目内的历史或未来拍摄日；大夜拍摄按拍摄归属日管理，不随零点自动切换。只加入所选拍摄日，不扩展常驻设备，不提前创建空文件夹。</p></div>
      <Button kind="icon" title="取消添加临时设备" disabled={busy} onClick={onClose}><X size={16} /></Button>
    </div>
    <div className="temporary-device-fields">
      <label>拍摄归属日<select aria-label="临时设备拍摄归属日" disabled={busy} value={date} onChange={(event) => setDate(event.target.value)}>
        {!projectShootingDates(project, tasks).includes(date) && <option value={date} disabled>请选择项目内有效的拍摄归属日</option>}
        {projectShootingDates(project, tasks).map((day) => <option key={day} value={day}>{day}</option>)}
      </select></label>
      <label>设备名称<input aria-label="临时设备名称" disabled={busy} value={device} maxLength={100} list="temporary-device-history" placeholder="例如 Drone、录音机" onChange={(event) => setDevice(event.target.value)} /></label>
      <label>机位（可选）<input aria-label="临时设备机位" disabled={busy} value={position} maxLength={100} placeholder="例如 A、B" onChange={(event) => setPosition(event.target.value)} /></label>
      <label>实际操作人<input aria-label="添加临时设备操作人" disabled={busy} value={actualOperator} maxLength={120} placeholder="本次操作人姓名" onChange={(event) => setActualOperator(event.target.value)} /></label>
    </div>
    <datalist id="temporary-device-history">{historicDevices.map((name) => <option key={name} value={name} />)}</datalist>
    <p className="temporary-device-note">保存后立即进入该拍摄日计划和项目汇总；休息日会恢复为拍摄日。若整机曾标记未使用，仅新增机位恢复应备份，其他已知机位维持原决定并留审计。即使取消本次备份，已保存的日计划仍保留，可在项目详情中撤销。</p>
    {error && <div className="error-box" role="alert">{error}</div>}
    <div className="temporary-device-actions">
      <Button kind="subtle" disabled={busy} onClick={onClose}>取消</Button>
      <Button kind="primary" disabled={busy || !device.trim() || !actualOperator.trim() || !projectShootingDates(project, tasks).includes(date)} onClick={() => void save()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存并用于本次备份</Button>
    </div>
  </section>;
}
