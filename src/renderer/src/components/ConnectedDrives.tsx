import { useState, useEffect, useCallback } from 'react'
import { HardDrive, RefreshCw, Eject, CheckCircle, AlertCircle } from 'lucide-react'

interface VolumeInfo {
  path: string
  name: string
  total: number
  free: number
  used: number
  deviceType: 'system' | 'source' | 'destination'
  canEject: boolean
}

interface ConnectedDrivesProps {
  onDriveSelect?: (drive: VolumeInfo) => void
}

export function ConnectedDrives({ onDriveSelect }: ConnectedDrivesProps) {
  const [volumes, setVolumes] = useState<VolumeInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null)

  const refreshVolumes = useCallback(async () => {
    setRefreshing(true)
    try {
      const vols = await window.api.listVolumes()
      setVolumes(vols)
    } catch (err) {
      console.error('Failed to list volumes:', err)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    refreshVolumes()
    const interval = setInterval(refreshVolumes, 30000) // 30秒刷新
    return () => clearInterval(interval)
  }, [refreshVolumes])

  const handleEject = async (path: string) => {
    try {
      await window.api.ejectVolume(path)
      await refreshVolumes()
    } catch (err) {
      console.error('Failed to eject volume:', err)
    }
  }

  const handleDriveClick = (drive: VolumeInfo) => {
    setSelectedDrive(drive.path)
    onDriveSelect?.(drive)
  }

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const getDeviceIcon = (type: string) => {
    switch (type) {
      case 'source':
        return <HardDrive size={18} className="text-amber-400" />
      case 'destination':
        return <HardDrive size={18} className="text-blue-400" />
      default:
        return <HardDrive size={18} className="text-gray-400" />
    }
  }

  const getDeviceLabel = (type: string) => {
    switch (type) {
      case 'source':
        return '素材卡'
      case 'destination':
        return '备份盘'
      default:
        return '系统盘'
    }
  }

  const getDeviceColor = (type: string) => {
    switch (type) {
      case 'source':
        return 'border-amber-500/30 bg-amber-600/10'
      case 'destination':
        return 'border-blue-500/30 bg-blue-600/10'
      default:
        return 'border-gray-500/30 bg-gray-600/10'
    }
  }

  const sourceCount = volumes.filter(v => v.deviceType === 'source').length
  const destCount = volumes.filter(v => v.deviceType === 'destination').length

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-200">已连接设备</h3>
          <div className="flex items-center gap-2">
            {sourceCount > 0 && (
              <span className="px-2 py-0.5 text-xs rounded bg-amber-600/20 text-amber-400">
                {sourceCount} 张素材卡
              </span>
            )}
            {destCount > 0 && (
              <span className="px-2 py-0.5 text-xs rounded bg-blue-600/20 text-blue-400">
                {destCount} 块备份盘
              </span>
            )}
          </div>
        </div>
        <button
          onClick={refreshVolumes}
          disabled={refreshing}
          className="p-2 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors disabled:opacity-50"
          title="刷新设备列表"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {volumes.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-gray-500">
          <HardDrive size={24} className="mr-3 opacity-50" />
          <span>暂无已连接设备</span>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {volumes.map((volume) => {
            const usedPercent = volume.total > 0 ? (volume.used / volume.total) * 100 : 0
            const isSelected = selectedDrive === volume.path

            return (
              <div
                key={volume.path}
                onClick={() => handleDriveClick(volume)}
                className={`
                  relative p-3 rounded-xl border cursor-pointer transition-all duration-200
                  ${isSelected
                    ? 'border-blue-500 bg-blue-600/10 ring-2 ring-blue-500/20'
                    : `${getDeviceColor(volume.deviceType)} hover:border-gray-500`
                  }
                `}
              >
                {/* 设备类型标签 */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {getDeviceIcon(volume.deviceType)}
                    <span className="text-xs font-medium text-gray-400">
                      {getDeviceLabel(volume.deviceType)}
                    </span>
                  </div>
                  {volume.canEject && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleEject(volume.path)
                      }}
                      className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                      title="安全弹出"
                    >
                      <Eject size={12} />
                    </button>
                  )}
                </div>

                {/* 设备名称 */}
                <div className="mb-2">
                  <p className="text-sm font-medium text-gray-200 truncate">{volume.name}</p>
                  <p className="text-xs text-gray-500 font-mono truncate">{volume.path}</p>
                </div>

                {/* 容量信息 */}
                <div className="mb-2">
                  <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
                    <span>{formatBytes(volume.used)} 已用</span>
                    <span>{formatBytes(volume.free)} 可用</span>
                  </div>
                  <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        usedPercent > 90 ? 'bg-red-500' :
                        usedPercent > 70 ? 'bg-yellow-500' :
                        'bg-green-500'
                      }`}
                      style={{ width: `${usedPercent}%` }}
                    />
                  </div>
                </div>

                {/* 容量警告 */}
                {usedPercent > 90 && (
                  <div className="flex items-center gap-1 mt-2 text-xs text-red-400">
                    <AlertCircle size={12} />
                    <span>存储空间不足</span>
                  </div>
                )}

                {/* 选中指示器 */}
                {isSelected && (
                  <div className="absolute top-2 right-2">
                    <CheckCircle size={16} className="text-blue-400" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
