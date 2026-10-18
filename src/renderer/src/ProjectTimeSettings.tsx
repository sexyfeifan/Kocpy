import { useId, useState } from "react";
import { validTimeZone, type ProjectTimeRules } from "../../common/time-context";
import { Button } from "./Ui";

export function ProjectTimeSettings({ value, onChange }: { value: ProjectTimeRules; onChange: (value: ProjectTimeRules) => void }) {
  const id = useId(), [day, setDay] = useState(""), [zone, setZone] = useState(""), [error, setError] = useState("");
  const zones = [...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, "Asia/Shanghai", "Asia/Tokyo", "Asia/Bangkok", "Europe/Paris", "Europe/London", "America/Los_Angeles", "America/New_York", "Pacific/Auckland", "UTC"])];
  return <section className="project-time-settings" aria-label="项目时间与大夜规则">
    <h3>拍摄时区与大夜归属</h3>
    <p className="muted small">拍摄归属日始终人工确认，不随午夜、时区或参考分界自动改变。设置只影响新分析与新任务，不改旧目录、源文件时间或历史证据。</p>
    <datalist id={id}>{zones.map(z => <option key={z} value={z} />)}</datalist>
    <div className="form-grid">
      <label>项目拍摄时区（IANA）<input aria-label="项目拍摄时区" list={id} placeholder="未记录；请确认拍摄地" value={value.projectTimeZone || ""} onChange={e => onChange({ ...value, projectTimeZone: e.target.value || undefined })} />
        {value.projectTimeZone && !validTimeZone(value.projectTimeZone) && <span role="alert">时区无效，例如 Asia/Shanghai</span>}
      </label>
      <label>大夜参考分界（只提示）<select aria-label="大夜参考分界" value={value.shootingDayBoundaryHour ?? 0} onChange={e => onChange({ ...value, shootingDayBoundaryHour: Number(e.target.value) })}>{Array.from({ length: 13 }, (_, h) => <option key={h} value={h}>{h === 0 ? "不作大夜分界提示" : `当地 ${String(h).padStart(2, "0")}:00 前提示可能属前一日`}</option>)}</select></label>
    </div>
    <details><summary>跨地区拍摄：按拍摄归属日覆盖时区（{Object.keys(value.shootingDayTimeZones || {}).length} 日）</summary>
      <p className="muted small">同一场大夜跨过午夜仍使用该拍摄归属日的时区；跨地区场次请指定实际时区。不确定的相机时钟仍须人工核对。</p>
      <div className="form-grid"><label>拍摄归属日<input aria-label="时区覆盖拍摄日" type="date" value={day} onChange={e => setDay(e.target.value)} /></label><label>该日拍摄时区<input aria-label="该日拍摄时区" list={id} value={zone} onChange={e => setZone(e.target.value)} placeholder="例如 Europe/Paris" /></label></div>
      <Button onClick={() => { if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !validTimeZone(zone)) return setError("请填写拍摄日和有效时区"); onChange({ ...value, shootingDayTimeZones: { ...value.shootingDayTimeZones, [day]: zone } }); setError(""); }}>添加／更新该日时区</Button>
      {error && <p role="alert">{error}</p>}
      <ul>{Object.entries(value.shootingDayTimeZones || {}).sort().map(([date, z]) => <li key={date}><span>{date} · {z}</span><Button onClick={() => { const next = { ...value.shootingDayTimeZones }; delete next[date]; onChange({ ...value, shootingDayTimeZones: Object.keys(next).length ? next : undefined }); }}>恢复项目时区</Button></li>)}</ul>
    </details>
  </section>;
}
