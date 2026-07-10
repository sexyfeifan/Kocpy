import { useTaskStore } from '../store/taskStore'
import { TaskCard } from '../components/TaskCard'
import { HardDrive, Plus, LogOut, ChevronDown, CreditCard, Database, Monitor, RefreshCw } from 'lucide-react'
import { useEffect, useState, useCallback, useRef } from 'react'
import type { VolumeInfo } from '../types'
import { formatBytes } from '../utils'

const DEVICE_TYPE_CONFIG = {
  system: { label: '系统盘', color: 'text-gray-400', bg: 'bg-gray-500/10 border-gray-500/20', Icon: Monitor },
  source: { label: '数据来源', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', Icon: CreditCard },
  destination: { label: '外接设备', color: 'text-blue-400', bg: 'bg-blue-500/10 border-blue-500/20', Icon: Database }
}

function ConnectedDrives(): JSX.Element {
  const [volumes, setVolumes] = useState<VolumeInfo[]>([])
  const [ejecting, setEjecting] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const vols = await window.api.listVolumes()
    setVolumes(vols)
  }, [])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 30000) // 30秒轮询，减少资源消耗
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleEject = async (vol: VolumeInfo) => {
    setEjecting(vol.path)
    await window.api.ejectVolume(vol.path)
    await refresh()
    setEjecting(null)
  }

  if (volumes.length === 0) return <></>

  const sourceCount = volumes.filter((v) => v.deviceType === 'source').length
  const destCount = volumes.filter((v) => v.deviceType === 'destination').length
  const externalCount = sourceCount + destCount

  return (
    <div className="mb-4 relative" ref={panelRef}>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#111] border border-[#2a2a2a] hover:border-[#3a3a3a] transition-colors text-sm text-gray-400"
        >
          <HardDrive size={14} className="text-gray-500" />
          <span>已连接 {volumes.length} 个储存设备</span>
          {sourceCount > 0 && (
            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <CreditCard size={10} />
              {sourceCount}
            </span>
          )}
          {destCount > 0 && (
            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20">
              <Database size={10} />
              {destCount}
            </span>
          )}
          <ChevronDown
            size={13}
            className={`text-gray-600 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        <button
          onClick={handleRefresh}
          title="刷新设备列表"
          className="p-2 rounded-lg bg-[#111] border border-[#2a2a2a] hover:border-[#3a3a3a] transition-colors text-gray-500 hover:text-gray-300"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-40 min-w-[420px] bg-[#141414] border border-[#2a2a2a] rounded-xl shadow-2xl p-3 flex flex-col gap-2">
          {volumes.map((vol) => {
            const usedPct = vol.total > 0 ? (vol.used / vol.total) * 100 : 0
            const isEjecting = ejecting === vol.path
            const typeCfg = DEVICE_TYPE_CONFIG[vol.deviceType]
            const TypeIcon = typeCfg.Icon
            return (
              <div key={vol.path} className="flex items-center gap-4 px-3 py-2.5 bg-[#1a1a1a] rounded-lg border border-[#242424]">
                <HardDrive size={16} className="text-gray-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-gray-200 truncate">{vol.name}</span>
                      <span className={`shrink-0 flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md border ${typeCfg.bg} ${typeCfg.color}`}>
                        <TypeIcon size={9} />
                        {typeCfg.label}
                      </span>
                    </div>
                    <span className="text-xs text-gray-500 ml-2 shrink-0">
                      {formatBytes(vol.free)} 可用 / {formatBytes(vol.total)}
                    </span>
                  </div>
                  <div className="h-1 bg-[#2a2a2a] rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${usedPct > 85 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-400' : 'bg-blue-500'}`}
                      style={{ width: `${usedPct}%` }}
                    />
                  </div>
                </div>
                {vol.canEject && (
                  <button
                    onClick={() => handleEject(vol)}
                    disabled={isEjecting}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-amber-400 hover:bg-amber-400/10 transition-colors disabled:opacity-40"
                    title="推出"
                  >
                    <LogOut size={14} />
                  </button>
                )}
              </div>
            )
          })}
          {externalCount === 0 && (
            <p className="text-xs text-gray-600 text-center py-2">未检测到外接存储设备</p>
          )}
        </div>
      )}
    </div>
  )
}

export function Dashboard(): JSX.Element {
  const { tasks, setActivePage } = useTaskStore()

  const running = tasks.filter((t) => t.status === 'running' || t.status === 'verifying')
  const completed = tasks.filter((t) => t.status === 'completed')
  const failed = tasks.filter((t) => t.status === 'failed')
  const totalBytes = tasks.filter((t) => t.status === 'completed').reduce((s, t) => s + t.totalBytes, 0)

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: '运行中', value: running.length, color: 'text-blue-400', dot: 'bg-blue-500' },
          { label: '已完成', value: completed.length, color: 'text-green-400', dot: 'bg-green-500' },
          { label: '失败', value: failed.length, color: 'text-red-400', dot: 'bg-red-500' },
          { label: '总数据量', value: formatBytes(totalBytes), color: 'text-gray-300', dot: 'bg-gray-500' }
        ].map(({ label, value, color, dot }) => (
          <div key={label} className="glass-card p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-2 h-2 rounded-full ${dot}`} />
              <span className="text-xs text-gray-500">{label}</span>
            </div>
            <span className={`text-2xl font-bold ${color}`}>{value}</span>
          </div>
        ))}
      </div>

      {/* Connected drives — collapsible pill */}
      <ConnectedDrives />

      {/* Active tasks */}
      {running.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            进行中
          </h2>
          <div className="flex flex-col gap-3">
            {running.map((t) => <TaskCard key={t.id} task={t} />)}
          </div>
        </div>
      )}

      {/* All tasks */}
      {tasks.length > 0 ? (
        <div>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
            全部任务
          </h2>
          <div className="flex flex-col gap-3">
            {tasks
              .filter((t) => t.status !== 'running' && t.status !== 'verifying')
              .map((t) => <TaskCard key={t.id} task={t} />)}
          </div>
        </div>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center h-64 text-center">
          <div className="w-16 h-16 rounded-2xl bg-[#1a1a1a] border border-[#2a2a2a] flex items-center justify-center mb-4">
            <HardDrive size={28} className="text-gray-600" />
          </div>
          <p className="text-gray-400 font-medium mb-1">暂无备份任务</p>
          <p className="text-gray-600 text-sm mb-4">选择素材源和目的地，开始你的第一次备份</p>
          <button
            onClick={() => setActivePage('new')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-medium transition-colors"
          >
            <Plus size={15} />
            新建备份任务
          </button>
        </div>
      )}
    </div>
  )
}
