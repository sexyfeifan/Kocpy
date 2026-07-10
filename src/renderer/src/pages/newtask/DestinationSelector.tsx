import { FolderOpen, Plus, Trash2 } from 'lucide-react'
import type { DestRow, Mode } from './shared'
import { formatBytes } from '../../utils'

interface Props {
  mode: Mode
  destinations: DestRow[]
  setDestinations: (fn: (prev: DestRow[]) => DestRow[]) => void
  pathPreviews: string[]
}

export function DestinationSelector({ mode, destinations, setDestinations, pathPreviews }: Props): JSX.Element {
  const addDestination = async () => {
    const p = await window.api.selectDirectory()
    if (!p) return
    const info = await window.api.getDriveInfo(p)
    setDestinations((prev) => [...prev, { id: Math.random().toString(36).slice(2), path: p, driveInfo: info }])
  }

  const removeDestination = (id: string) =>
    setDestinations((prev) => prev.filter((d) => d.id !== id))

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">备份目的地</label>
        <span className="text-xs text-gray-600">{destinations.length} 个</span>
      </div>

      <div className="flex flex-col gap-2 mb-3">
        {destinations.map((dest, idx) => (
          <div key={dest.id} className={`bg-[#111] border rounded-xl px-4 py-3 ${dest.driveInfo ? 'border-[#2a2a2a]' : 'border-amber-500/30'}`}>
            <div className="flex items-center gap-3">
              <FolderOpen size={14} className={`shrink-0 ${dest.driveInfo ? 'text-green-400' : 'text-amber-500'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 break-all">{dest.path}</p>
                {dest.driveInfo ? (
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1 bg-[#2a2a2a] rounded-full overflow-hidden">
                      <div className="h-full bg-green-500/60 rounded-full" style={{ width: `${(dest.driveInfo.used / dest.driveInfo.total) * 100}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 shrink-0">剩余 {formatBytes(dest.driveInfo.free)}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mt-1">
                    <p className="text-xs text-amber-500/80 flex-1">设备未连接，请手动选择路径</p>
                    <button
                      onClick={async () => {
                        const p = await window.api.selectDirectory()
                        if (!p) return
                        const info = await window.api.getDriveInfo(p).catch(() => null)
                        setDestinations((prev) => prev.map((d) => d.id === dest.id ? { ...d, path: p, driveInfo: info } : d))
                      }}
                      className="shrink-0 text-xs text-amber-400 hover:text-amber-300 border border-amber-500/30 rounded-lg px-2 py-0.5 transition-colors"
                    >选择路径</button>
                  </div>
                )}
              </div>
              <button onClick={() => removeDestination(dest.id)} className="p-1.5 text-gray-600 hover:text-red-400 transition-colors shrink-0">
                <Trash2 size={14} />
              </button>
            </div>
            {mode === 'project' && pathPreviews[idx] && (
              <div className="mt-2 pt-2 border-t border-[#1e1e1e]">
                <p className="text-xs text-gray-600 mb-0.5">预计路径</p>
                <p className="text-xs text-blue-400/70 font-mono break-all">{pathPreviews[idx]}</p>
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={addDestination}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-[#2a2a2a] text-gray-500 hover:border-[#444] hover:text-gray-400 transition-all text-sm"
      >
        <Plus size={15} />添加目的地
      </button>
    </div>
  )
}
