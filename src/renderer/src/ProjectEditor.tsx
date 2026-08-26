import { useState } from "react";
import { X, Plus, FolderOpen, Check, LoaderCircle, Info } from "lucide-react";
import { api, today, type ProjectConfig } from "./api";
import { Button } from "./App";
export function ProjectEditor({
  initial,
  onClose,
  onSave,
}: {
  initial: Partial<ProjectConfig>;
  onClose: () => void;
  onSave: (p: ProjectConfig) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name || ""),
    [volumePrefix, setVolumePrefix] = useState(initial.volumePrefix || "CARD"),
    [start, setStart] = useState(initial.shootingDateStart || today()),
    [end, setEnd] = useState(initial.shootingDateEnd || today()),
    [devices, setDevices] = useState(initial.devices?.join("、") || "A机、B机"),
    [dests, setDests] = useState(initial.destinationPaths || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setError("");
    if (!name.trim()) return setError("请输入项目名称");
    if (!start || !end || end < start)
      return setError("请填写有效的拍摄日期范围");
    if (!devices.trim()) return setError("请至少添加一个机位");
    setBusy(true);
    try {
      await onSave({
        ...initial,
        id: initial.id || crypto.randomUUID(),
        name: name.trim(),
        devices: [
          ...new Set(
            devices
              .split(/[、,，]/)
              .map((d) => d.trim())
              .filter(Boolean),
          ),
        ],
        volumePrefix: volumePrefix.trim() || "CARD",
        shootingDateStart: start,
        shootingDateEnd: end,
        destinationPaths: dests,
        status: initial.status || "active",
        createdAt: initial.createdAt || Date.now(),
      });
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
        aria-label={initial.id ? "编辑项目" : "新建项目"}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">PRODUCTION PROJECT</span>
            <h2>{initial.id ? "编辑拍摄项目" : "为下一次拍摄做好准备"}</h2>
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
          <label>
            项目名称
            <input
              autoFocus
              aria-label="项目名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：山海之间 · 品牌短片"
            />
          </label>
          <div className="form-grid">
            <label>
              开始日期
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              结束日期
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <label>
            拍摄机位
            <input
              aria-label="拍摄机位"
              value={devices}
              onChange={(e) => setDevices(e.target.value)}
              placeholder="A机、B机、无人机"
            />
            <small>用顿号或逗号分隔，备份时可选择本次机位。</small>
          </label>
          <label>
            素材卷号前缀
            <input aria-label="素材卷号前缀" value={volumePrefix} onChange={(e) => setVolumePrefix(e.target.value)} placeholder="例如 CARD" />
            <small>确认开始备份后按机位自动递增，例如 CARD001、CARD002。</small>
          </label>
          <label>
            常用备份目的地 <small>可在每次备份前调整</small>
          </label>
          {dests.map((p) => (
            <div className="chosen-path" key={p}>
              <FolderOpen size={18} />
              <span className="mono path">{p}</span>
              <Button
                kind="icon"
                title="移除此目的地"
                onClick={() => setDests((d) => d.filter((x) => x !== p))}
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
                  .then((p) => {
                    if (p) setDests((d) => (d.includes(p) ? d : [...d, p]));
                  })
                  .catch((e) => setError(String(e)))
              }
            >
              <Plus size={15} />
              添加目的地
            </Button>
          )}
          <div className="notice">
            <Info size={16} />
            保存项目只记录配置；首次备份时才在目的地创建项目 / 日期 / 机位目录。
          </div>
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
