import { useState, useEffect } from 'react'
import { HardDrive, RefreshCw, LogOut } from 'lucide-react'

/**
 * 接入介质显示组件 - 完全参考 DiskHop 设计
 * 显示所有已连接的存储设备，包括本地硬盘
 */

export type Volume = {
  name: string
  path: string
  totalBytes: number
  freeBytes: number
  format: string
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

// ─── Volume Card ─────────────────────────────────────────────────────────────
function VolumeCard({
  volume,
  isSelected,
  onToggle,
  onEject,
  ejectLabel,
}: {
  volume: Volume
  isSelected: boolean
  onToggle: () => void
  onEject: (e: React.MouseEvent) => void
  ejectLabel: string
}) {
  const usedBytes = volume.totalBytes - volume.freeBytes
  const usedPct = volume.totalBytes > 0 ? (usedBytes / volume.totalBytes) * 100 : 0
  const barColor = usedPct > 85 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-400' : 'bg-accent-blue'

  return (
    <div
      className={`
        relative flex flex-col gap-1.5 bg-bg-card border rounded-xl px-3 py-2.5 transition-colors group text-left cursor-pointer
        ${isSelected ? 'border-accent-blue bg-blue-950/30' : 'border-border hover:border-accent-blue hover:bg-blue-950/20'}
      `}
      onClick={onToggle}
    >
      <button
        onClick={onEject}
        title={ejectLabel}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-amber-400 z-10"
      >
        <LogOut size={13} />
      </button>
      <div className="flex items-center gap-2 pr-5">
        <HardDrive size={18} className={`shrink-0 transition-colors ${isSelected ? 'text-accent-blue' : 'text-gray-400 group-hover:text-accent-blue'}`} />
        <span className="text-xs text-gray-200 truncate font-medium flex-1">{volume.name}</span>
        {isSelected && <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue border border-accent-blue/30 shrink-0">已选择</span>}
      </div>
      <div className="w-full h-1.5 rounded-full bg-gray-700/60 overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.min(usedPct, 100).toFixed(1)}%` }} />
      </div>
      <div className="flex items-center justify-between gap-1">
        <div className="flex flex-col">
          <span className="text-[9px] text-gray-500 uppercase tracking-wider">已用</span>
          <span className="text-[11px] text-gray-300 font-mono font-medium">{formatBytes(usedBytes)}</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-[9px] text-gray-600">{usedPct.toFixed(0)}%</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-[9px] text-gray-500 uppercase tracking-wider">剩余</span>
          <span className="text-[11px] text-gray-300 font-mono font-medium">{formatBytes(volume.freeBytes)}</span>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-600 font-mono">{volume.format || '—'}</span>
        <span className="text-[10px] text-gray-600 font-mono">总容量 {formatBytes(volume.totalBytes)}</span>
      </div>
    </div>
  )
}

// ─── Connected Drives Component ──────────────────────────────────────────────
interface ConnectedDrivesProps {
  selectedVolumes?: string[]
  onVolumeToggle?: (path: string) => void
  onVolumeEject?: (path: string) => Promise<void>
  showRefresh?: boolean
  columns?: number
}

export function ConnectedDrives({
  selectedVolumes = [],
  onVolumeToggle,
  onVolumeEject,
  showRefresh = true,
  columns = 2
}: ConnectedDrivesProps) {
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const loadVolumes = async () => {
    setRefreshing(true)
    try {
      const data = await window.api.listVolumes()
      setVolumes(data || [])
    } catch (err) {
      console.error('Failed to load volumes:', err)
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadVolumes()
  }, [])

  const handleToggle = (path: string) => {
    if (onVolumeToggle) {
      onVolumeToggle(path)
    }
  }

  const handleEject = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation()
    if (onVolumeEject) {
      await onVolumeEject(path)
    }
    // 移除已弹出的卷
    setVolumes(prev => prev.filter(v => v.path !== path))
  }

  const gridCols = {
    1: 'grid-cols-1',
    2: 'grid-cols-1 md:grid-cols-2',
    3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
  }

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-200">接入介质</h3>
        {showRefresh && (
          <button
            onClick={loadVolumes}
            disabled={refreshing}
            className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors disabled:opacity-50"
            title="刷新设备列表"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        )}
      </div>

      {volumes.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <HardDrive size={24} className="mx-auto mb-2 opacity-50" />
          <p className="text-sm">暂无已连接设备</p>
        </div>
      ) : (
        <div className={`grid ${gridCols[columns as keyof typeof gridCols] || gridCols[2]} gap-3`}>
          {volumes.map((volume) => (
            <VolumeCard
              key={volume.path}
              volume={volume}
              isSelected={selectedVolumes.includes(volume.path)}
              onToggle={() => handleToggle(volume.path)}
              onEject={(e) => handleEject(e, volume.path)}
              ejectLabel="安全弹出"
            />
          ))}
        </div>
      )}
    </div>
  )
}
