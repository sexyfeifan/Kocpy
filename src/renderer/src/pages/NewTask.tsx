import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { FolderOpen, Plus, Trash2, Play, ChevronDown, CheckCircle, HelpCircle, X, RefreshCw, Zap, HardDrive } from 'lucide-react'
import { useTaskStore } from '../store/taskStore'
import type { VolumeInfo } from '../types'
import { formatBytes, todayLocal } from '../utils'

function dateToCompact(dateStr: string): string {
  return dateStr.replace(/-/g, '')
}

interface DriveInfo { total: number; free: number; used: number }

interface DestRow {
  id: string
  path: string
  driveInfo: DriveInfo | null
}

type Mode = 'card' | 'mirror' | 'project'

export function NewTask(): JSX.Element {
  const { addTask, setActivePage, projects, projectsError, devices, loadProjects, loadDevices } = useTaskStore()

  const [mode, setMode] = useState<Mode>('card')
  const [sourcePath, setSourcePath] = useState('')
  const [destinations, setDestinations] = useState<DestRow[]>([])
  const [defaultHash, setDefaultHash] = useState<'md5' | 'sha1' | 'sha256'>('md5')
  const [shootingDate, setShootingDate] = useState(todayLocal())
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [selectedPosition, setSelectedPosition] = useState<string>('')
  const [volumePrefix, setVolumePrefix] = useState('Untitled')
  const [isStarting, setIsStarting] = useState(false)
  const [duplicateStrategy, setDuplicateStrategy] = useState<'skip' | 'suffix'>('skip')
  const [generateThumbnails, setGenerateThumbnails] = useState(false)
  const [taskPriority] = useState(false)
  const [fx3Rename, setFx3Rename] = useState(false)
  const [includeHidden, setIncludeHidden] = useState(true)

  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [refreshingProjects, setRefreshingProjects] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [detectedSources, setDetectedSources] = useState<VolumeInfo[]>([])
  const [sourceTab, setSourceTab] = useState<'card' | 'custom'>('card')
  const autoDetectedRef = useRef(false)

  // Resolved path from project structure
  const [resolvedPath, setResolvedPath] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setDefaultHash(s.defaultHash)
      if (s.defaultDuplicateStrategy) setDuplicateStrategy(s.defaultDuplicateStrategy)
      if (s.defaultGenerateThumbnails != null) setGenerateThumbnails(s.defaultGenerateThumbnails)
    })
    // 异步调用需要正确处理
    loadProjects().catch((err) => {
      console.error('Failed to load projects:', err)
    })
    loadDevices().catch((err) => {
      console.error('Failed to load devices:', err)
    })
  }, [])

  // Reload projects when switching to project mode
  useEffect(() => {
    if (mode === 'project') {
      loadProjects().catch((err) => {
        console.error('Failed to reload projects:', err)
      })
    }
  }, [mode])

  // Scan for source volumes in all modes — poll every 30s (reduced from 5s for better performance)
  const scanSources = useCallback(async () => {
    const vols = await window.api.listVolumes()
    setDetectedSources(vols.filter((v) => v.deviceType === 'source'))
  }, [])

  useEffect(() => {
    scanSources()
    const id = setInterval(scanSources, 30000) // 30秒轮询，减少资源消耗
    return () => clearInterval(id)
  }, [scanSources])

  // Auto-fill source when exactly 1 source detected and none selected yet
  useEffect(() => {
    if (sourcePath !== '' || autoDetectedRef.current) return
    if (detectedSources.length !== 1) return
    const vol = detectedSources[0]
    setSourcePath(vol.path)
    const volumeMatch = vol.path.match(/^\/Volumes\/([^/]+)/)
    const volName = (volumeMatch ? volumeMatch[1] : (vol.path.split('/').pop() || 'Untitled'))
      .replace(/_\d{12}$/, '')
    setVolumePrefix(volName)
    autoDetectedRef.current = true
  }, [detectedSources, sourcePath])

  // Projects sorted newest-first
  const activeProjects = useMemo(
    () => projects
      .filter((p) => p.status !== 'archived')
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [projects]
  )

  const selectedProject = activeProjects.find((p) => p.id === selectedProjectId)

  // Camera positions for the selected device in the selected project
  const availablePositions = useMemo(() => {
    if (!selectedProject || !selectedDevice) return []
    return selectedProject.devicePositions?.[selectedDevice] ?? []
  }, [selectedProject, selectedDevice])

  // Auto-resolve path when project + date + device + position are all set
  useEffect(() => {
    if (mode !== 'project') return
    if (!selectedProjectId || !shootingDate || !selectedDevice || !selectedPosition) {
      setResolvedPath(null)
      return
    }
    let cancelled = false
    setResolving(true)
    window.api
      .resolveBackupPath({
        projectId: selectedProjectId,
        shootingDate,
        deviceName: selectedDevice,
        positionLabel: selectedPosition
      })
      .then((path: string) => {
        if (!cancelled) setResolvedPath(path)
      })
      .catch(() => {
        if (!cancelled) setResolvedPath(null)
      })
      .finally(() => {
        if (!cancelled) setResolving(false)
      })
    return () => { cancelled = true }
  }, [mode, selectedProjectId, shootingDate, selectedDevice, selectedPosition])

  const isNew = (createdAt?: number) =>
    createdAt != null && Date.now() - createdAt < 7 * 24 * 3600 * 1000

  // applyProject only sets the date — selectedProjectId is set by the button onClick
  const applyProject = (projectId: string) => {
    const p = projects.find((pr) => pr.id === projectId)
    if (!p) return
    const dateToSet = p.shootingDateStart ?? p.shootingDate ?? todayLocal()
    setShootingDate(dateToSet)
  }

  // Reset position when device or project changes
  useEffect(() => {
    setSelectedPosition('')
  }, [selectedDevice, selectedProjectId])

  // Reset device + position when project changes
  useEffect(() => {
    setSelectedDevice('')
  }, [selectedProjectId])

  // Fill destinations when a project is selected — single execution path, no race condition
  useEffect(() => {
    if (mode !== 'project' || !selectedProjectId) return
    const p = projects.find((pr) => pr.id === selectedProjectId)
    if (!p?.destinationPaths?.length) {
      setDestinations([])
      return
    }
    let cancelled = false
    Promise.all(
      p.destinationPaths.map(async (path) => {
        const info = await window.api.getDriveInfo(path).catch(() => null)
        return { id: Math.random().toString(36).slice(2), path, driveInfo: info }
      })
    ).then((rows) => {
      if (!cancelled) setDestinations(rows)
    }).catch(() => {
      if (!cancelled) setDestinations([])
    })
    return () => { cancelled = true }
  }, [selectedProjectId, mode])

  const selectSource = async () => {
    const p = await window.api.selectDirectory()
    if (!p) return
    setSourcePath(p)
    autoDetectedRef.current = false
    const volumeMatch = p.match(/^\/Volumes\/([^/]+)/)
    const volName = (volumeMatch ? volumeMatch[1] : (p.split('/').pop() || 'Untitled'))
      .replace(/_\d{12}$/, '')
    setVolumePrefix(volName)
  }

  const addDestination = async () => {
    const p = await window.api.selectDirectory()
    if (!p) return
    const info = await window.api.getDriveInfo(p)
    setDestinations((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), path: p, driveInfo: info }
    ])
  }

  const removeDestination = (id: string) =>
    setDestinations((prev) => prev.filter((d) => d.id !== id))

  // Real-time path preview for manually-added destinations (project mode only)
  const pathPreviews = useMemo(() => {
    if (mode !== 'project') return []
    const dateCompact = dateToCompact(shootingDate)
    const projectName = selectedProject?.name ?? ''
    const topFolder = projectName ? `${dateCompact}${projectName}` : dateCompact
    const volName = `${volumePrefix || 'Untitled'}_<时间戳>`

    return destinations.map((dest) => {
      const hasProjectName = !!projectName
      if (hasProjectName) {
        return selectedDevice
          ? `${dest.path}/${topFolder}/${dateCompact}/${selectedDevice}/${volName}`
          : `${dest.path}/${topFolder}/${dateCompact}/${volName}`
      } else {
        return selectedDevice
          ? `${dest.path}/${topFolder}/${selectedDevice}/${volName}`
          : `${dest.path}/${topFolder}/${volName}`
      }
    })
  }, [mode, shootingDate, selectedProject, volumePrefix, selectedDevice, destinations])

  const canStartCard = sourcePath && destinations.length > 0
  const canStartMirror = sourcePath && destinations.length > 0
  // Project: can start if source set and either a resolved project path or at least 1 manual destination
  // If the selected device has sub-positions defined, a position must also be chosen
  const positionRequired = availablePositions.length > 0 && selectedPosition === ''
  const canStartAdvanced =
    sourcePath &&
    selectedDevice !== '' &&
    !positionRequired &&
    (resolvedPath !== null || destinations.length > 0)

  const canStart =
    mode === 'card' ? canStartCard :
    mode === 'mirror' ? canStartMirror :
    canStartAdvanced

  const handleStart = async () => {
    if (!canStart) return
    setIsStarting(true)
    try {
      const destPaths =
        mode === 'project' && resolvedPath
          ? [resolvedPath, ...destinations.map((d) => d.path)]
          : destinations.map((d) => d.path)

      const hasOverlap = destPaths.some(
        (dp) => dp === sourcePath || dp.startsWith(sourcePath + '/') || sourcePath.startsWith(dp + '/')
      )
      if (hasOverlap) {
        alert('来源路径与目的地路径存在重叠，请重新选择。')
        setIsStarting(false)
        return
      }

      const task = await window.api.createTask({
        name: '',
        sourcePath,
        devices: mode === 'project' ? [selectedDevice] : [],
        destinationPaths: destPaths,
        hashAlgorithm: defaultHash,
        namingTemplate:
          mode === 'card'
            ? (sourcePath.split('/').pop() || 'Untitled')
            : mode === 'mirror'
              ? (sourcePath.split('/').pop() || 'Untitled')
              : (volumePrefix || 'Untitled'),
        shootingDate: mode === 'project' ? shootingDate : '',
        projectName: mode === 'project' ? (selectedProject?.name ?? '') : '',
        copyMode: mode === 'mirror' ? 'mirror' : 'normal',
        duplicateStrategy,
        generateThumbnails,
        priority: taskPriority,
        fx3Rename,
        includeHidden
      })
      addTask(task)
      await window.api.startTask(task.id)
      setActivePage('dashboard')
    } finally {
      setIsStarting(false)
    }
  }

  const isMirror = mode === 'mirror'

  const pickVolume = async (vol: VolumeInfo) => {
    // macOS requires a user-initiated open dialog to grant sandbox access to the volume path.
    // We open the dialog with the volume as default so the user just clicks "Select".
    const picked = await window.api.selectDirectory(vol.path)
    if (!picked) return
    setSourcePath(picked)
    const m = picked.match(/^\/Volumes\/([^/]+)/)
    const n = (m ? m[1] : (picked.split('/').pop() || 'Untitled')).replace(/_\d{12}$/, '')
    setVolumePrefix(n)
    autoDetectedRef.current = true
  }

  const tabbedSourceSection = (
    <div className="glass-card p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <HardDrive size={14} className="text-gray-400" />
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            数据源
          </label>
          {autoDetectedRef.current && sourcePath && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 font-semibold">
              <Zap size={9} />
              自动识别
            </span>
          )}
        </div>
        {sourcePath && (
          <button
            onClick={() => { setSourcePath(''); autoDetectedRef.current = false; setVolumePrefix('Untitled') }}
            className="text-xs text-gray-600 hover:text-gray-300 transition-colors px-2 py-0.5 rounded-lg hover:bg-white/5"
          >
            清除
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-0 mb-4 border-b border-[#2a2a2a]">
        <button
          onClick={() => setSourceTab('card')}
          className={`px-4 py-2 text-xs font-medium transition-all border-b-2 -mb-px ${
            sourceTab === 'card'
              ? mode === 'mirror'
                ? 'border-purple-500 text-purple-400'
                : 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          素材卡
        </button>
        <button
          onClick={() => setSourceTab('custom')}
          className={`px-4 py-2 text-xs font-medium transition-all border-b-2 -mb-px ${
            sourceTab === 'custom'
              ? mode === 'mirror'
                ? 'border-purple-500 text-purple-400'
                : 'border-blue-500 text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          自定义
        </button>
      </div>

      {sourceTab === 'card' ? (
        <div>
          {detectedSources.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-6 rounded-xl border border-dashed border-[#2a2a2a] text-center">
              <HardDrive size={22} className="text-gray-700" />
              <p className="text-xs text-gray-600">未检测到素材卡</p>
              <p className="text-[11px] text-gray-700">支持 SD · CFexpress Type A/B · CFast · CF · SxS · XQD</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {detectedSources.map((vol) => {
                const isSelected = sourcePath === vol.path
                return (
                  <button
                    key={vol.path}
                    onClick={() => pickVolume(vol)}
                    className={`w-full text-left flex items-center gap-3 px-4 py-3.5 rounded-xl border transition-all ${
                      isSelected
                        ? isMirror
                          ? 'bg-purple-600/10 border-purple-500/30'
                          : 'bg-blue-600/10 border-blue-500/30'
                        : 'bg-[#111] border-[#2a2a2a] hover:border-[#3a3a3a] hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                      isSelected
                        ? isMirror ? 'bg-purple-600/20' : 'bg-blue-600/20'
                        : 'bg-[#1a1a1a]'
                    }`}>
                      <FolderOpen size={18} className={isSelected
                        ? isMirror ? 'text-purple-400' : 'text-blue-400'
                        : 'text-gray-500'
                      } />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold truncate ${isSelected
                        ? isMirror ? 'text-purple-200' : 'text-blue-200'
                        : 'text-gray-200'
                      }`}>
                        {vol.name}
                      </p>
                      {vol.total != null && vol.total > 0 && (
                        <p className="text-xs text-gray-500 mt-0.5">{formatBytes(vol.total)}</p>
                      )}
                    </div>
                    {isSelected && (
                      <CheckCircle size={15} className={isMirror ? 'text-purple-400 shrink-0' : 'text-blue-400 shrink-0'} />
                    )}
                  </button>
                )
              })}
            </div>
          )}
          {sourcePath && !detectedSources.find((v) => v.path === sourcePath) && (
            <div className={`mt-2 px-3 py-2.5 rounded-xl border ${
              isMirror ? 'bg-purple-600/8 border-purple-500/20' : 'bg-blue-600/8 border-blue-500/20'
            }`}>
              <p className={`text-xs font-mono break-all ${isMirror ? 'text-purple-300/70' : 'text-blue-300/70'}`}>{sourcePath}</p>
            </div>
          )}
        </div>
      ) : (
        <div>
          <button
            onClick={selectSource}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all text-sm ${
              sourcePath
                ? isMirror
                  ? 'bg-purple-600/10 border-purple-500/30 text-purple-300'
                  : 'bg-blue-600/10 border-blue-500/30 text-blue-300'
                : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#444] hover:text-gray-400 border-dashed'
            }`}
          >
            <FolderOpen size={16} className="shrink-0" />
            <span className="truncate text-left flex-1">{sourcePath || '点击选择文件夹...'}</span>
          </button>
          {sourcePath && (
            <p className="text-xs text-gray-600 mt-1.5 font-mono break-all">{sourcePath}</p>
          )}
        </div>
      )}

      {/* FX3 备份重命名 — only in card mode */}
      {mode === 'card' && (
        <label className="flex items-center justify-between cursor-pointer mt-3 pt-3 border-t border-[#1e1e1e]">
          <div>
            <p className="text-xs text-gray-300">FX3 备份重命名</p>
            <p className="text-[11px] text-gray-600 mt-0.5">备份前将 Untitled 文件夹按视频前缀重命名</p>
          </div>
          <div
            onClick={() => setFx3Rename((v) => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${fx3Rename ? 'bg-blue-600' : 'bg-[#2a2a2a]'}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${fx3Rename ? 'left-4' : 'left-0.5'}`} />
          </div>
        </label>
      )}
    </div>
  )

  const sourceSection = tabbedSourceSection
  const advancedSourceSection = tabbedSourceSection

  const destSection = (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          备份目的地
        </label>
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
                      <div
                        className="h-full bg-green-500/60 rounded-full"
                        style={{ width: `${(dest.driveInfo.used / dest.driveInfo.total) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-500 shrink-0">
                      剩余 {formatBytes(dest.driveInfo.free)}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mt-1">
                    <p className="text-xs text-amber-500/80 flex-1">设备未连接，请手动选择路径</p>
                    <button
                      onClick={async () => {
                        const p = await window.api.selectDirectory()
                        if (!p) return
                        const info = await window.api.getDriveInfo(p).catch(() => null)
                        setDestinations((prev) =>
                          prev.map((d) => d.id === dest.id ? { ...d, path: p, driveInfo: info } : d)
                        )
                      }}
                      className="shrink-0 text-xs text-amber-400 hover:text-amber-300 border border-amber-500/30 rounded-lg px-2 py-0.5 transition-colors"
                    >
                      选择路径
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => removeDestination(dest.id)}
                className="p-1.5 text-gray-600 hover:text-red-400 transition-colors shrink-0"
              >
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
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-[#2a2a2a] text-gray-500
          hover:border-[#444] hover:text-gray-400 transition-all text-sm"
      >
        <Plus size={15} />
        添加目的地
      </button>
    </div>
  )

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto w-full">
      {/* Help modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowHelp(false)}>
          <div
            className="relative w-full max-w-lg mx-4 bg-[#141414] border border-[#2a2a2a] rounded-2xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e1e1e]">
              <div className="flex items-center gap-2">
                <HelpCircle size={16} className="text-blue-400" />
                <span className="text-sm font-semibold text-gray-200">项目模式使用指南</span>
              </div>
              <button onClick={() => setShowHelp(false)} className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors">
                <X size={15} />
              </button>
            </div>
            <div className="overflow-y-auto max-h-[65vh] p-6 flex flex-col gap-5">
              {[
                {
                  n: 1, title: '先在项目管理中创建项目',
                  desc: '填写项目名称、拍摄日期范围、摄影机设备及子机位，添加目的地硬盘，然后点击「创建文件结构」预建目录树。',
                  example: '项目名称: 项目2026\n日期: 2026-04-20 → 2026-04-25\n设备: A机(子位置 A/B)、B机'
                },
                {
                  n: 2, title: '选择关联项目',
                  desc: '点击下拉框选择已创建的项目。系统会自动填入拍摄日期范围和目的地路径。',
                  example: '关联项目: 项目2026\n→ 自动填入目的地: /Volumes/Archive'
                },
                {
                  n: 3, title: '选择日期 · 机位 · 子位置',
                  desc: '选择当天拍摄日期，点选对应机位（如 A机）和子位置（如 A），系统自动解析完整目标路径。',
                  example: '日期: 2026-04-21 | 机位: A机 | 位置: A\n→ /Volumes/Archive/20260420城市探店自贡/20260421/A机/A/'
                },
                {
                  n: 4, title: '设置卷名并开始备份',
                  desc: '「卷名」填素材卡名称（选源后自动读取卷名）。最终文件夹名为「卷名_时间戳」，确保每次备份唯一可追溯。',
                  example: '卷名: SonyA7IV\n→ 最终: SonyA7IV_202604211435'
                }
              ].map((step) => (
                <div key={step.n} className="flex gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-xs font-bold text-blue-400">
                    {step.n}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-200 mb-1">{step.title}</p>
                    <p className="text-xs text-gray-400 leading-relaxed mb-2">{step.desc}</p>
                    <pre className="text-[10px] text-blue-300/70 font-mono bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg px-3 py-2 whitespace-pre-wrap leading-relaxed">
                      {step.example}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-6 py-3 border-t border-[#1e1e1e]">
              <p className="text-xs text-gray-600 text-center">点击空白处关闭 · 备卡/镜像模式直接选源和目的地即可，无需配置项目</p>
            </div>
          </div>
        </div>
      )}

      {/* Mode toggle */}
      <div className="flex gap-1 p-1 bg-[#111] border border-[#2a2a2a] rounded-xl mb-4">
        <button
          onClick={() => {
            if (mode === 'card') return
            setMode('card')
            setSourcePath('')
            setDestinations([])
            autoDetectedRef.current = false
            setSelectedProjectId('')
            setSelectedDevice('')
            setSelectedPosition('')
            setResolvedPath(null)
            setSourceTab('card')
          }}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === 'card'
              ? 'bg-blue-600 text-white shadow'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          备卡模式
        </button>
        <button
          onClick={() => {
            if (mode === 'mirror') return
            setMode('mirror')
            setSourcePath('')
            setDestinations([])
            autoDetectedRef.current = false
            setSelectedProjectId('')
            setSelectedDevice('')
            setSelectedPosition('')
            setResolvedPath(null)
            setSourceTab('card')
          }}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === 'mirror'
              ? 'bg-purple-600 text-white shadow'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          镜像模式
        </button>
        <button
          onClick={() => {
            if (mode === 'project') return
            setMode('project')
            setSourcePath('')
            setDestinations([])
            autoDetectedRef.current = false
            setSelectedProjectId('')
            setSelectedDevice('')
            setSelectedPosition('')
            setResolvedPath(null)
            setSourceTab('card')
          }}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === 'project'
              ? 'bg-blue-600 text-white shadow'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          项目模式
        </button>
        {mode === 'project' && (
          <button
            onClick={() => setShowHelp(true)}
            className="px-3 py-2 rounded-lg text-gray-600 hover:text-blue-400 transition-colors"
            title="使用指南"
          >
            <HelpCircle size={14} />
          </button>
        )}
      </div>

      {/* Mode description banner */}
      {mode === 'card' && (
        <div className="mb-5 px-4 py-3.5 bg-blue-600/8 border border-blue-500/20 rounded-xl flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">备卡模式 · Card Mode</span>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            将素材卡中的文件备份到指定目的地。备份目录以「卷名_时间戳」命名，确保每次备份可唯一追溯。支持同时备份到多个目的地，全部目的地备份完成后逐文件哈希校验。
          </p>
          <div className="flex flex-col gap-1">
            {[
              { step: '①', text: '选择素材卡或文件夹作为素材源' },
              { step: '②', text: '添加一个或多个目的地目录' },
              { step: '③', text: '点击开始备份，完成后自动哈希校验' },
            ].map(({ step, text }) => (
              <p key={step} className="text-xs text-blue-300/60"><span className="mr-1.5">{step}</span>{text}</p>
            ))}
          </div>
        </div>
      )}
      {mode === 'mirror' && (
        <div className="mb-5 px-4 py-3.5 bg-purple-600/8 border border-purple-500/20 rounded-xl flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">镜像模式 · Mirror Mode</span>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            完整镜像素材源的目录结构与文件名，目的地内容与素材源完全一致（A = B）。适用于需要制作完全相同副本的场景，例如将卡内容原封不动同步到多块硬盘。
          </p>
          <div className="flex flex-col gap-1">
            {[
              { step: '①', text: '选择素材卡或文件夹作为素材源' },
              { step: '②', text: '添加一个或多个目的地（均得到相同镜像）' },
              { step: '③', text: '开始备份，目录结构与文件名原样保留' },
            ].map(({ step, text }) => (
              <p key={step} className="text-xs text-purple-300/60"><span className="mr-1.5">{step}</span>{text}</p>
            ))}
          </div>
        </div>
      )}
      {mode === 'project' && (
        <div className="mb-5 px-4 py-3.5 bg-blue-600/8 border border-blue-500/20 rounded-xl flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-blue-400 uppercase tracking-wider">项目模式 · Project Mode</span>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">
            关联已创建的项目，自动识别素材卡、自动填充目的地路径，按「项目 / 日期 / 机位 / 卷名_时间戳」层级归档。适合多机位、多日拍摄的系统化管理工作流。
          </p>
          <div className="flex flex-col gap-1">
            {[
              { step: '①', text: '在项目管理中提前创建项目并预建目录结构' },
              { step: '②', text: '选择项目，系统自动填入目的地与拍摄日期' },
              { step: '③', text: '选择日期、机位、子位置，自动解析完整备份路径' },
              { step: '④', text: '确认卷名后开始备份，结果按层级自动归档' },
            ].map(({ step, text }) => (
              <p key={step} className="text-xs text-blue-300/60"><span className="mr-1.5">{step}</span>{text}</p>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {mode === 'card' ? (
          <>
            {sourceSection}
            {destSection}
          </>
        ) : mode === 'mirror' ? (
          <>
            {sourceSection}
            {destSection}
          </>
        ) : (
          <>
            {/* Project selector — inline list, no floating dropdown */}
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-3">
                <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  关联项目
                </label>
                <button
                  onClick={async () => {
                    setRefreshingProjects(true)
                    await loadProjects()
                    setRefreshingProjects(false)
                  }}
                  title="刷新项目列表"
                  className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-white/5 transition-colors"
                >
                  <RefreshCw size={13} className={refreshingProjects ? 'animate-spin' : ''} />
                </button>
              </div>

              {/* Selected project banner */}
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
                  <button
                    onClick={() => { setSelectedProjectId(''); setDestinations([]) }}
                    className="ml-3 p-1 shrink-0 text-blue-400/50 hover:text-blue-300 transition-colors"
                    title="取消关联"
                  >
                    <X size={13} />
                  </button>
                </div>
              )}

              {/* Inline project list — top 5, expandable */}
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
                          if (active) { setSelectedProjectId(''); setDestinations([]) }
                          else { setSelectedProjectId(p.id); applyProject(p.id) }
                        }}
                        className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm transition-all ${
                          active
                            ? 'bg-blue-600/10 border-blue-500/30 text-blue-300'
                            : 'bg-[#111] border-[#2a2a2a] text-gray-300 hover:border-[#3a3a3a] hover:bg-white/[0.03]'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{p.name}</span>
                              {isNew(p.createdAt) && (
                                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-blue-600/20 text-blue-400 border border-blue-500/30 font-semibold">
                                  NEW
                                </span>
                              )}
                            </div>
                            {dateRange && (
                              <div className={`text-xs mt-0.5 ${active ? 'text-blue-400/60' : 'text-gray-500'}`}>{dateRange}</div>
                            )}
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

            {/* Shooting date — constrained to project plan range if project selected */}
            <div className="glass-card p-5">
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                拍摄日期
              </label>
              <input
                type="date"
                value={shootingDate}
                min={selectedProject?.shootingDateStart ?? undefined}
                max={selectedProject?.shootingDateEnd ?? undefined}
                onChange={(e) => setShootingDate(e.target.value)}
                className="w-full bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-gray-200
                  focus:outline-none focus:border-blue-500 transition-colors
                  [color-scheme:dark]"
              />
              {selectedProject?.shootingDateStart && (
                <p className="text-xs text-gray-600 mt-1.5">
                  项目计划：{selectedProject.shootingDateStart}
                  {selectedProject.shootingDateEnd && selectedProject.shootingDateEnd !== selectedProject.shootingDateStart
                    ? ` → ${selectedProject.shootingDateEnd}`
                    : ''}
                </p>
              )}
            </div>

            {/* Device selection — from project devices if project selected, else global devices */}
            <div className="glass-card p-5">
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                机位选择
              </label>
              {(() => {
                const deviceList = selectedProject?.devices?.length
                  ? selectedProject.devices
                  : (devices ?? [])
                if (deviceList.length === 0) {
                  return <p className="text-xs text-gray-500">请在项目管理中添加机位</p>
                }
                return (
                  <div className="flex flex-wrap gap-2">
                    {deviceList.map((device) => {
                      const active = selectedDevice === device
                      return (
                        <button
                          key={device}
                          onClick={() => setSelectedDevice(active ? '' : device)}
                          className={`px-4 py-2 rounded-xl border text-sm font-medium transition-all
                            ${active
                              ? 'bg-blue-600/15 border-blue-500/40 text-blue-300'
                              : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#3a3a3a]'
                            }`}
                        >
                          {device}
                        </button>
                      )
                    })}
                  </div>
                )
              })()}
              {selectedDevice === '' && (selectedProject?.devices?.length ?? (devices?.length ?? 0)) > 0 && (
                <p className="text-xs text-amber-500/70 mt-2">请选择一个机位</p>
              )}
            </div>

            {/* Camera position — only shown when device is selected and positions exist */}
            {selectedDevice && availablePositions.length > 0 && (
              <div className="glass-card p-5">
                <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                  机位子位置
                </label>
                <div className="flex flex-wrap gap-2">
                  {availablePositions.map((pos) => {
                    const active = selectedPosition === pos
                    return (
                      <button
                        key={pos}
                        onClick={() => setSelectedPosition(active ? '' : pos)}
                        className={`px-4 py-2 rounded-xl border text-sm font-medium transition-all
                          ${active
                            ? 'bg-purple-600/15 border-purple-500/40 text-purple-300'
                            : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#3a3a3a]'
                          }`}
                      >
                        {pos}
                      </button>
                    )
                  })}
                </div>
                {selectedPosition === '' && (
                  <p className="text-xs text-amber-500/70 mt-2">请选择一个子位置</p>
                )}
              </div>
            )}

            {/* Resolved path confirmation panel */}
            {(resolvedPath || resolving) && (
              <div className={`glass-card p-5 border ${resolvedPath ? 'border-green-500/20' : 'border-[#2a2a2a]'}`}>
                <div className="flex items-center gap-2 mb-2">
                  {resolvedPath ? (
                    <CheckCircle size={14} className="text-green-400 shrink-0" />
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-600 border-t-blue-400 animate-spin shrink-0" />
                  )}
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    {resolvedPath ? '自动解析目的地' : '正在解析路径...'}
                  </span>
                </div>
                {resolvedPath && (
                  <p className="text-xs text-green-400/80 font-mono break-all">{resolvedPath}</p>
                )}
              </div>
            )}

            {/* Volume prefix */}
            <div className="glass-card p-5">
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                卷名
              </label>
              <input
                type="text"
                value={volumePrefix}
                onChange={(e) => setVolumePrefix(e.target.value)}
                placeholder="Untitled"
                className="w-full bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600
                  focus:outline-none focus:border-blue-500 transition-colors"
              />
              <p className="text-xs text-gray-600 mt-1.5">
                最终卷名: <span className="text-gray-500 font-mono">{volumePrefix || 'Untitled'}_&lt;当前时间戳&gt;</span>
              </p>
            </div>

            {advancedSourceSection}
            {destSection}
          </>
        )}

        {/* Advanced options */}
        <div className="glass-card p-5 flex flex-col gap-4">
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">高级选项</label>

          {/* Toggles row */}
          <div className="flex flex-col gap-3">
            {/* Generate thumbnails */}
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="text-xs text-gray-300">视频首帧缩略图</p>
                <p className="text-[11px] text-gray-600 mt-0.5">备份完成后提取 MXF / MOV / MP4 / R3D / BRAW 首帧</p>
              </div>
              <div
                onClick={() => setGenerateThumbnails((v) => !v)}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                  generateThumbnails ? 'bg-blue-600' : 'bg-[#2a2a2a]'
                }`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                  generateThumbnails ? 'left-4' : 'left-0.5'
                }`} />
              </div>
            </label>
            {/* Include hidden files */}
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="text-xs text-gray-300">包含隐藏文件</p>
                <p className="text-[11px] text-gray-600 mt-0.5">备份以 . 开头的文件（如 ._ 元数据、.RDC 文件夹等）</p>
              </div>
              <div
                onClick={() => setIncludeHidden((v) => !v)}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                  includeHidden ? 'bg-blue-600' : 'bg-[#2a2a2a]'
                }`}
              >
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                  includeHidden ? 'left-4' : 'left-0.5'
                }`} />
              </div>
            </label>
          </div>
        </div>

        {/* Start button */}
        <button
          onClick={handleStart}
          disabled={!canStart || isStarting}
          className={`flex items-center justify-center gap-2 w-full py-4 rounded-xl font-semibold text-sm transition-all
            ${canStart && !isStarting
              ? mode === 'mirror'
                ? 'bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/25'
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/25'
              : 'bg-[#1a1a1a] text-gray-600 border border-[#2a2a2a] cursor-not-allowed'
            }`}
        >
          <Play size={16} />
          {isStarting ? '正在启动...' : '开始备份'}
        </button>

        {!canStart && (
          <p className="text-center text-xs text-gray-600">
          {mode === 'card' || mode === 'mirror'
              ? '请选择素材源和至少一个目的地'
              : positionRequired
                ? '请选择机位子位置'
                : resolvedPath === null
                  ? '请选择素材源、机位，或添加手动目的地'
                  : '请选择素材源和机位'}
          </p>
        )}
      </div>
    </div>
  )
}
