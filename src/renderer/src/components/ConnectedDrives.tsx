import { useState, useEffect } from 'react'
import { HardDrive, RefreshCw, LogOut } from 'lucide-react'

interface Volume {
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

interface VolumeCardProps {
  volume: Volume
  isSelected: boolean
  onToggle: () => void
  onEject: (e: React.MouseEvent) => void
}

function VolumeCard({ volume, isSelected, onToggle, onEject }: VolumeCardProps) {
  const usedBytes = volume.totalBytes - volume.freeBytes
  const usedPct = volume.totalBytes > 0 ? (usedBytes / volume.totalBytes) * 100 : 0
  const barColor = usedPct > 85 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-400' : 'bg-blue-500'

  return (
    <div
      className={`
        relative flex flex-col gap-2 p-3 rounded-xl border cursor-pointer transition-all duration-200 group
        ${isSelected
          ? 'border-blue-500 bg-blue-950/30'
          : 'border-gray-700 hover:border-blue-500 hover:bg-blue-950/20'
        }
      `}
      onClick={onToggle}
    >
      {/* 弹出按钮 */}
      <button
        onClick={onEject}
        title="安全弹出"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 hover:text-amber-400 z-10"
      >
        <LogOut size={13} />
      </button>

      {/* 设备信息 */}
      <div className="flex items-center gap-2 pr-5">
        <HardDrive
          size={18}
          className={`shrink-0 transition-colors ${
            isSelected ? 'text-blue-400' : 'text-gray-400 group-hover:text-blue-400'
          }`}
        />
        <span className="text-sm text-gray-200 truncate font-medium flex-1">
          {volume.name}
        </span>
        {isSelected && (
          <span className="text-xs px-2 py-0.5 rounded bg-blue-600/20 text-blue-400 border border-blue-500/30 shrink-0">
            已选择
          </span>
        )}
      </div>

      {/* 容量进度条 */}
      <div className="w-full h-1.5 rounded-full bg-gray-700/60 overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor} transition-all`}
          style={{ width: `${Math.min(usedPct, 100).toFixed(1)}%` }}
        />
      </div>

      {/* 容量信息 */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex flex-col">
          <span className="text-xs text-gray-500 uppercase tracking-wider">已用</span>
          <span className="text-xs text-gray-300 font-mono font-medium">{formatBytes(usedBytes)}</span>
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-gray-600">{usedPct.toFixed(0)}%</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="text-xs text-gray-500 uppercase tracking-wider">剩余</span>
          <span className="text-xs text-gray-300 font-mono font-medium">{formatBytes(volume.freeBytes)}</span>
        </div>
      </div>

      {/* 格式和总容量 */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-600 font-mono">{volume.format || '—'}</span>
        <span className="text-xs text-gray-600 font-mono">总容量 {formatBytes(volume.totalBytes)}</span>
      </div>
    </div>
  )
}

interface ConnectedDrivesProps {
  onVolumeSelect?: (volume: Volume) => void
}

export function ConnectedDrives({ onVolumeSelect }: ConnectedDrivesProps) {
  const [volumes, setVolumes] = useState<Volume[]>([])
  const [selectedVolume, setSelectedVolume] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const loadVolumes = async () => {
    setRefreshing(true)
    try {
      const data = await window.api.listVolumes()
      setVolumes(data)
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
    setSelectedVolume(prev => prev === path ? null : path)
    const volume = volumes.find(v => v.path === path)
    if (volume && onVolumeSelect) {
      onVolumeSelect(volume)
    }
  }

  const handleEject = async (e: React.MouseEvent, volume: Volume) => {
    e.stopPropagation()
    try {
      await window.api.ejectVolume(volume.path)
      // 移除已弹出的卷
      setVolumes(prev => prev.filter(v => v.path !== volume.path))
      if (selectedVolume === volume.path) {
        setSelectedVolume(null)
      }
    } catch (err) {
      console.error('Failed to eject volume:', err)
    }
  }

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-200">接入介质</h3>
        <button
          onClick={loadVolumes}
          disabled={refreshing}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors disabled:opacity-50"
          title="刷新设备列表"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {volumes.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <HardDrive size={24} className="mx-auto mb-2 opacity-50" />
          <p className="text-sm">暂无已连接设备</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {volumes.map((volume) => (
            <VolumeCard
              key={volume.path}
              volume={volume}
              isSelected={selectedVolume === volume.path}
              onToggle={() => handleToggle(volume.path)}
              onEject={(e) => handleEject(e, volume)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
