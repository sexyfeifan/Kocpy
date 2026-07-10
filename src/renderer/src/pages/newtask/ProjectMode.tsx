import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { FolderOpen, ChevronDown, CheckCircle, X, RefreshCw, HardDrive } from 'lucide-react'
import type { ProjectConfig, VolumeInfo } from '../../types'
import type { DestRow } from './shared'
import { formatBytes } from '../../utils'
import { DestinationSelector } from './DestinationSelector'

interface Props {
  sourcePath: string
  setSourcePath: (p: string) => void
  setVolumePrefix: (v: string) => void
  detectedSources: VolumeInfo[]
  autoDetected: boolean
  setAutoDetected: (v: boolean) => void
  destinations: DestRow[]
  setDestinations: (fn: (prev: DestRow[]) => DestRow[]) => void
}

export function ProjectMode({
  sourcePath, setSourcePath, setVolumePrefix,
  detectedSources, autoDetected, setAutoDetected,
  destinations, setDestinations
}: Props): JSX.Element {
  const { projects, projectsError, devices, loadProjects } = useProjectData()

  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [refreshingProjects, setRefreshingProjects] = useState(false)
  const [shootingDate, setShootingDate] = useState(todayLocal())
  const [selectedDevice, setSelectedDevice] = useState('')
  const [selectedPosition, setSelectedPosition] = useState('')
  const [volumePrefixLocal, setVolumePrefixLocal] = useState('Untitled')
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const autoDetectedRef = useRef(false)

  const activeProjects = useMemo(
    () => projects.filter((p) => p.status !== 'archived').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [projects]
  )

  const selectedProject = activeProjects.find((p) => p.id === selectedProjectId)

  const availablePositions = useMemo(() => {
    if (!selectedProject || !selectedDevice) return []
    return selectedProject.devicePositions?.[selectedDevice] ?? []
  }, [selectedProject, selectedDevice])

  const positionRequired = availablePositions.length > 0 && selectedPosition === ''

  const isNew = (createdAt?: number) =>
    createdAt != null && Date.now() - createdAt < 7 * 24 * 3600 * 1000

  // Auto-fill source when exactly 1 source detected
  useEffect(() => {
    if (sourcePath !== '' || autoDetectedRef.current) return
    if (detectedSources.length !== 1) return
    const vol = detectedSources[0]
    setSourcePath(vol.path)
    const volumeMatch = vol.path.match(/^\/Volumes\/([^/]+)/)
    const volName = (volumeMatch ? volumeMatch[1] : (vol.path.split('/').pop() || 'Untitled')).replace(/_\d{12}$/, '')
    setVolumePrefixLocal(volName)
    setVolumePrefix(volName)
    autoDetectedRef.current = true
  }, [detectedSources, sourcePath])

  // Reset position when device or project changes
  useEffect(() => { setSelectedPosition('') }, [selectedDevice, selectedProjectId])
  useEffect(() => { setSelectedDevice('') }, [selectedProjectId])

  // Auto-resolve path
  useEffect(() => {
    if (!selectedProjectId || !shootingDate || !selectedDevice || !selectedPosition) {
      setResolvedPath(null)
      return
    }
    let cancelled = false
    setResolving(true)
    window.api.resolveBackupPath({ projectId: selectedProjectId, shootingDate, deviceName: selectedDevice, positionLabel: selectedPosition })
      .then((p: string) => { if (!cancelled) setResolvedPath(p) })
      .catch(() => { if (!cancelled) setResolvedPath(null) })
      .finally(() => { if (!cancelled) setResolving(false) })
    return () => { cancelled = true }
  }, [selectedProjectId, shootingDate, selectedDevice, selectedPosition])

  // Fill destinations when project selected
  useEffect(() => {
    if (!selectedProjectId) return
    const p = projects.find((pr) => pr.id === selectedProjectId)
    if (!p?.destinationPaths?.length) { setDestinations(() => []); return }
    let cancelled = false
    Promise.all(
      p.destinationPaths.map(async (path) => {
        const info = await window.api.getDriveInfo(path).catch(() => null)
        return { id: Math.random().toString(36).slice(2), path, driveInfo: info }
      })
    ).then((rows) => { if (!cancelled) setDestinations(() => rows) })
    return () => { cancelled = true }
  }, [selectedProjectId])

  // Sync volume prefix up
  useEffect(() => { setVolumePrefix(volumePrefixLocal) }, [volumePrefixLocal])

  const applyProject = (projectId: string) => {
    const p = projects.find((pr) => pr.id === projectId)
    if (!p) return
    setShootingDate(p.shootingDateStart ?? p.shootingDate ?? todayLocal())
  }

  const pickVolume = async (vol: VolumeInfo) => {
    const picked = await window.api.selectDirectory(vol.path)
    if (!picked) return
    setSourcePath(picked)
    const m = picked.match(/^\/Volumes\/([^/]+)/)
    const n = (m ? m[1] : (picked.split('/').pop() || 'Untitled')).replace(/_\d{12}$/, '')
    setVolumePrefixLocal(n)
    setVolumePrefix(n)
    autoDetectedRef.current = true
  }

  const selectSource = async () => {
    const p = await window.api.selectDirectory()
    if (!p) return
    setSourcePath(p)
    autoDetectedRef.current = false
    const volumeMatch = p.match(/^\/Volumes\/([^/]+)/)
    const volName = (volumeMatch ? volumeMatch[1] : (p.split('/').pop() || 'Untitled')).replace(/_\d{12}$/, '')
    setVolumePrefixLocal(volName)
    setVolumePrefix(volName)
  }

  const pathPreviews = useMemo(() => {
    const dateCompact = shootingDate.replace(/-/g, '')
    const projectName = selectedProject?.name ?? ''
    const topFolder = projectName ? `${dateCompact}${projectName}` : dateCompact
    const volName = `${volumePrefixLocal || 'Untitled'}_<时间戳>`
    return destinations.map((dest) => {
      if (projectName) {
        return selectedDevice
          ? `${dest.path}/${topFolder}/${dateCompact}/${selectedDevice}/${volName}`
          : `${dest.path}/${topFolder}/${dateCompact}/${volName}`
      } else {
        return selectedDevice
          ? `${dest.path}/${topFolder}/${selectedDevice}/${volName}`
          : `${dest.path}/${topFolder}/${volName}`
      }
    })
  }, [shootingDate, selectedProject, volumePrefixLocal, selectedDevice, destinations])

  const canStart = sourcePath && selectedDevice !== '' && !positionRequired && (resolvedPath !== null || destinations.length > 0)

  return (
    <div className="flex flex-col gap-5">
      {/* Project selector */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">关联项目</label>
          <button
            onClick={async () => { setRefreshingProjects(true); await loadProjects(); setRefreshingProjects(false) }}
            title="刷新项目列表"
            className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-white/5 transition-colors"
          ><RefreshCw size={13} className={refreshingProjects ? 'animate-spin' : ''} /></button>
        </div>

        {selectedProject && (
          <div className="flex items-center justify-between px-3 py-2.5 mb-3 rounded-xl bg-blue-600/10 border border-blue-500/30">
            <div className="min-w-0">
              <p className="text-sm font-medium text-blue-300 truncate">{selectedProject.name}</p>
              {(() => {
                const dr = selectedProject.shootingDateStart
                  ? `${selectedProject.shootingDateStart}${selectedProject.shootingDateEnd && selectedProject.shootingDateEnd !== selectedProject.shootingDateStart ? ' → ' + selectedProject.shootingDateEnd : ''}`
                  : (selectedProject.shootingDate ?? '')
                return dr ? <p className="text-xs text-blue-400/60 mt-0.5">{dr}</p> : null
              })()}
              {selectedProject.destinationPaths?.length ? (
                <div className="mt-1.5 flex flex-col gap-0.5">
                  {selectedProject.destinationPaths.map((dp) => (
                    <p key={dp} className="text-[10px] text-blue-400/40 font-mono truncate">{dp}</p>
                  ))}
                </div>
              ) : null}
            </div>
            <button onClick={() => { setSelectedProjectId(''); setDestinations(() => []) }} className="ml-3 p-1 shrink-0 text-blue-400/50 hover:text-blue-300 transition-colors" title="取消关联">
              <X size={13} />
            </button>
          </div>
        )}

        {refreshingProjects ? (
          <div className="flex items-center gap-2 px-3 py-3 rounded-xl bg-[#111] border border-[#2a2a2a]">
            <div className="w-3 h-3 rounded-full border-2 border-gray-600 border-t-blue-400 animate-spin shrink-0" />
            <p className="text-xs text-gray-500">正在加载...</p>
          </div>
        ) : projectsError ? (
          <div className="flex items-center gap-2 px-3 py-3 rounded-xl bg-red-500/5 border border-red-500/20">
            <p className="text-xs text-red-400/80">{projectsError}</p>
          </div>
        ) : activeProjects.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 rounded-xl bg-[#111] border border-[#2a2a2a]">
            <p className="text-xs text-gray-500">暂无活跃项目，请先在项目管理中创建</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {(showAllProjects ? activeProjects : activeProjects.slice(0, 5)).map((p) => {
              const active = p.id === selectedProjectId
              const dateRange = p.shootingDateStart
                ? `${p.shootingDateStart}${p.shootingDateEnd && p.shootingDateEnd !== p.shootingDateStart ? ' → ' + p.shootingDateEnd : ''}`
                : (p.shootingDate ?? '')
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    if (active) { setSelectedProjectId(''); setDestinations(() => []) }
                    else { setSelectedProjectId(p.id); applyProject(p.id) }
                  }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm transition-all ${
                    active ? 'bg-blue-600/10 border-blue-500/30 text-blue-300' : 'bg-[#111] border-[#2a2a2a] text-gray-300 hover:border-[#3a3a3a] hover:bg-white/[0.03]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{p.name}</span>
                        {isNew(p.createdAt) && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold">NEW</span>
                        )}
                      </div>
                      {dateRange && <div className={`text-xs mt-0.5 ${active ? 'text-blue-400/60' : 'text-gray-500'}`}>{dateRange}</div>}
                    </div>
                    {active && <CheckCircle size={14} className="text-blue-400 shrink-0" />}
                  </div>
                </button>
              )
            })}
            {activeProjects.length > 5 && (
              <button
                onClick={() => setShowAllProjects((v) => !v)}
                className="flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-xl border border-dashed border-[#2a2a2a] text-xs text-gray-500 hover:text-gray-300 hover:border-[#3a3a3a] transition-colors"
              >
                <ChevronDown size={12} className={`transition-transform ${showAllProjects ? 'rotate-180' : ''}`} />
                {showAllProjects ? '收起' : `查看全部 ${activeProjects.length} 个项目`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Shooting date */}
      <div className="glass-card p-5">
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">拍摄日期</label>
        <input
          type="date"
          value={shootingDate}
          min={selectedProject?.shootingDateStart ?? undefined}
          max={selectedProject?.shootingDateEnd ?? undefined}
          onChange={(e) => setShootingDate(e.target.value)}
          className="w-full bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-gray-200 focus:outline-none focus:border-blue-500 transition-colors [color-scheme:dark]"
        />
        {selectedProject?.shootingDateStart && (
          <p className="text-xs text-gray-600 mt-1.5">
            项目计划：{selectedProject.shootingDateStart}
            {selectedProject.shootingDateEnd && selectedProject.shootingDateEnd !== selectedProject.shootingDateStart ? ` → ${selectedProject.shootingDateEnd}` : ''}
          </p>
        )}
      </div>

      {/* Device selection */}
      <div className="glass-card p-5">
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">机位选择</label>
        {(() => {
          const deviceList = selectedProject?.devices?.length ? selectedProject.devices : devices
          if (deviceList.length === 0) return <p className="text-xs text-gray-500">请在项目管理中添加机位</p>
          return (
            <div className="flex flex-wrap gap-2">
              {deviceList.map((device) => {
                const active = selectedDevice === device
                return (
                  <button
                    key={device}
                    onClick={() => setSelectedDevice(active ? '' : device)}
                    className={`px-4 py-2 rounded-xl border text-sm font-medium transition-all ${active ? 'bg-blue-600/15 border-blue-500/40 text-blue-300' : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#3a3a3a]'}`}
                  >{device}</button>
                )
              })}
            </div>
          )
        })()}
        {selectedDevice === '' && (selectedProject?.devices?.length ?? devices.length) > 0 && (
          <p className="text-xs text-amber-500/70 mt-2">请选择一个机位</p>
        )}
      </div>

      {/* Camera position */}
      {selectedDevice && availablePositions.length > 0 && (
        <div className="glass-card p-5">
          <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">机位子位置</label>
          <div className="flex flex-wrap gap-2">
            {availablePositions.map((pos) => {
              const active = selectedPosition === pos
              return (
                <button
                  key={pos}
                  onClick={() => setSelectedPosition(active ? '' : pos)}
                  className={`px-4 py-2 rounded-xl border text-sm font-medium transition-all ${active ? 'bg-purple-600/15 border-purple-500/40 text-purple-300' : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#3a3a3a]'}`}
                >{pos}</button>
              )
            })}
          </div>
          {selectedPosition === '' && <p className="text-xs text-amber-500/70 mt-2">请选择一个子位置</p>}
        </div>
      )}

      {/* Resolved path */}
      {(resolvedPath || resolving) && (
        <div className={`glass-card p-5 border ${resolvedPath ? 'border-green-500/20' : 'border-[#2a2a2a]'}`}>
          <div className="flex items-center gap-2 mb-2">
            {resolvedPath ? <CheckCircle size={14} className="text-green-400 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-600 border-t-blue-400 animate-spin shrink-0" />}
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{resolvedPath ? '自动解析目的地' : '正在解析路径...'}</span>
          </div>
          {resolvedPath && <p className="text-xs text-green-400/80 font-mono break-all">{resolvedPath}</p>}
        </div>
      )}

      {/* Volume prefix */}
      <div className="glass-card p-5">
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">卷名</label>
        <input
          type="text"
          value={volumePrefixLocal}
          onChange={(e) => { setVolumePrefixLocal(e.target.value); setVolumePrefix(e.target.value) }}
          placeholder="Untitled"
          className="w-full bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
        />
        <p className="text-xs text-gray-600 mt-1.5">
          最终卷名: <span className="text-gray-500 font-mono">{volumePrefixLocal || 'Untitled'}_&lt;当前时间戳&gt;</span>
        </p>
      </div>

      {/* Source selector (custom for project mode) */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <HardDrive size={14} className="text-gray-400" />
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">数据源</label>
            {autoDetected && sourcePath && (
              <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 font-semibold">自动识别</span>
            )}
          </div>
          {sourcePath && (
            <button
              onClick={() => { setSourcePath(''); setAutoDetected(false); setVolumePrefixLocal('Untitled'); setVolumePrefix('Untitled') }}
              className="text-xs text-gray-600 hover:text-gray-300 transition-colors px-2 py-0.5 rounded-lg hover:bg-white/5"
            >清除</button>
          )}
        </div>

        {detectedSources.length === 0 ? (
          <button
            onClick={selectSource}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-sm ${
              sourcePath ? 'bg-blue-600/10 border-blue-500/30 text-blue-300' : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#444] hover:text-gray-400 border-dashed'
            }`}
          >
            <FolderOpen size={16} className="shrink-0" />
            <span className="truncate text-left flex-1">{sourcePath || '点击选择文件夹...'}</span>
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            {detectedSources.map((vol) => {
              const isSelected = sourcePath === vol.path
              return (
                <button
                  key={vol.path}
                  onClick={() => pickVolume(vol)}
                  className={`w-full text-left flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all ${
                    isSelected ? 'bg-blue-600/10 border-blue-500/30' : 'bg-[#111] border-[#2a2a2a] hover:border-[#3a3a3a] hover:bg-white/[0.03]'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isSelected ? 'bg-blue-600/20' : 'bg-[#1a1a1a]'}`}>
                    <FolderOpen size={18} className={isSelected ? 'text-blue-400' : 'text-gray-500'} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold truncate ${isSelected ? 'text-blue-200' : 'text-gray-200'}`}>{vol.name}</p>
                    {vol.total != null && vol.total > 0 && <p className="text-xs text-gray-500 mt-0.5">{formatBytes(vol.total)}</p>}
                  </div>
                  {isSelected && <CheckCircle size={15} className="text-blue-400 shrink-0" />}
                </button>
              )
            })}
          </div>
        )}
        {sourcePath && !detectedSources.find((v) => v.path === sourcePath) && (
          <div className="mt-2 px-3 py-2.5 rounded-xl border bg-blue-600/8 border-blue-500/20">
            <p className="text-xs font-mono break-all text-blue-300/70">{sourcePath}</p>
          </div>
        )}
      </div>

      {/* Destinations */}
      <DestinationSelector mode="project" destinations={destinations} setDestinations={setDestinations} pathPreviews={pathPreviews} />
    </div>
  )
}

// ── Helper hooks/data ─────────────────────────────────────────────────────

function useProjectData() {
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [devices, setDevices] = useState<string[]>([])

  const loadProjects = useCallback(async () => {
    try {
      const p = await window.api.getProjects()
      setProjects(p)
      setProjectsError(null)
    } catch {
      setProjectsError('加载失败，请点刷新重试')
    }
  }, [])

  useEffect(() => {
    loadProjects()
    window.api.getDevices().then(setDevices)
  }, [loadProjects])

  return { projects, projectsError, devices, loadProjects }
}

function todayLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
