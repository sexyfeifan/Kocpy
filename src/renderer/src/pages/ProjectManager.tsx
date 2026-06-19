import { useState, useEffect, useRef } from 'react'
import {
  FolderOpen, Plus, Trash2, Pencil, Check, X, Archive, ArchiveRestore,
  LayoutList, LayoutGrid, Cpu, HardDrive, Calendar, FolderPlus, Save, ChevronDown, HelpCircle
} from 'lucide-react'
import { v4 as uuidv4 } from 'uuid'
import type { ProjectConfig } from '../types'

function formatBytes(b: number): string {
  if (b === 0) return '0 B'
  const k = 1024, s = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(b) / Math.log(k))
  return `${(b / Math.pow(k, i)).toFixed(1)} ${s[i]}`
}

function todayLocal(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface DriveInfo { total: number; free: number; used: number }
interface DestRow { id: string; path: string; driveInfo: DriveInfo | null }

// ─── Device management row ────────────────────────────────────────────────────
function DeviceRow({
  device, onRename, onRemove
}: {
  device: string
  onRename: (o: string, n: string) => Promise<void>
  onRemove: (name: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(device)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  const confirm = async () => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== device) await onRename(device, trimmed)
    else setValue(device)
    setEditing(false)
  }
  const cancel = () => { setValue(device); setEditing(false) }

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-[#111] border border-[#2a2a2a] rounded-xl">
      {editing ? (
        <>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') cancel() }}
            className="flex-1 bg-transparent text-sm text-gray-200 focus:outline-none"
          />
          <div className="flex items-center gap-1 ml-2 shrink-0">
            <button onClick={confirm} className="p-1.5 text-green-400 hover:text-green-300 transition-colors"><Check size={13} /></button>
            <button onClick={cancel} className="p-1.5 text-gray-600 hover:text-gray-400 transition-colors"><X size={13} /></button>
          </div>
        </>
      ) : (
        <>
          <span className="text-sm text-gray-200">{device}</span>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setEditing(true)} className="p-1.5 text-gray-600 hover:text-blue-400 transition-colors"><Pencil size={13} /></button>
            <button onClick={() => onRemove(device)} className="p-1.5 text-gray-600 hover:text-red-400 transition-colors"><Trash2 size={13} /></button>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Camera position manager per device ──────────────────────────────────────
function PositionManager({
  device, positions, onChange
}: {
  device: string
  positions: string[]
  onChange: (device: string, positions: string[]) => void
}) {
  const [newPos, setNewPos] = useState('')
  const [open, setOpen] = useState(false)

  const add = () => {
    const t = newPos.trim()
    if (!t || positions.includes(t)) return
    onChange(device, [...positions, t])
    setNewPos('')
  }

  const remove = (p: string) => onChange(device, positions.filter((x) => x !== p))

  return (
    <div className="ml-2 mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-400 transition-colors"
      >
        <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        机位子分组 {positions.length > 0 && <span className="text-blue-400/70">({positions.join(', ')})</span>}
      </button>
      {open && (
        <div className="mt-1.5 ml-3 flex flex-col gap-1">
          {positions.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <span className="text-xs text-blue-400/80 font-mono">{p}</span>
              <button onClick={() => remove(p)} className="text-gray-700 hover:text-red-400 transition-colors"><X size={10} /></button>
            </div>
          ))}
          <div className="flex gap-1 mt-0.5">
            <input
              value={newPos}
              onChange={(e) => setNewPos(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="如 A、B、C"
              className="flex-1 bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg px-2 py-1 text-xs text-gray-300 placeholder-gray-700 focus:outline-none"
            />
            <button
              onClick={add}
              disabled={!newPos.trim()}
              className="px-2 py-1 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-gray-500 hover:text-blue-400 disabled:opacity-40 transition-colors"
            >
              <Plus size={11} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Project edit / create panel ──────────────────────────────────────────────
function ProjectEditPanel({
  project, allDevices, onSave, onCancel, onDeviceAdd, onDeviceRemove, onDeviceRename
}: {
  project: Partial<ProjectConfig> | null
  allDevices: string[]
  onSave: (p: ProjectConfig) => Promise<void>
  onCancel: () => void
  onDeviceAdd: (name: string) => Promise<void>
  onDeviceRemove: (name: string) => Promise<void>
  onDeviceRename: (o: string, n: string) => Promise<void>
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [dateStart, setDateStart] = useState(
    project?.shootingDateStart ?? project?.shootingDate ?? todayLocal()
  )
  const [dateEnd, setDateEnd] = useState(
    project?.shootingDateEnd ?? project?.shootingDate ?? todayLocal()
  )
  const [selectedDevices, setSelectedDevices] = useState<string[]>(project?.devices ?? [])
  const [devicePositions, setDevicePositions] = useState<Record<string, string[]>>(
    project?.devicePositions ?? {}
  )
  const [destinations, setDestinations] = useState<DestRow[]>([])
  const [saving, setSaving] = useState(false)
  const [creatingStructure, setCreatingStructure] = useState(false)
  const [structureResult, setStructureResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null)
  const [newDevice, setNewDevice] = useState('')
  const [addingDevice, setAddingDevice] = useState(false)
  const [dateError, setDateError] = useState('')

  useEffect(() => {
    if (!project?.destinationPaths?.length) { setDestinations([]); return }
    Promise.all(
      project.destinationPaths.map(async (p) => {
        const info = await window.api.getDriveInfo(p).catch(() => null)
        return { id: uuidv4(), path: p, driveInfo: info }
      })
    ).then(setDestinations)
  }, [])

  const toggleDevice = (d: string) =>
    setSelectedDevices((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d])

  const updatePositions = (device: string, positions: string[]) =>
    setDevicePositions((prev) => ({ ...prev, [device]: positions }))

  const addDest = async () => {
    const p = await window.api.selectDirectory()
    if (!p) return
    const info = await window.api.getDriveInfo(p).catch(() => null)
    setDestinations((prev) => [...prev, { id: uuidv4(), path: p, driveInfo: info }])
  }

  const handleAddDevice = async () => {
    const n = newDevice.trim()
    if (!n || allDevices.includes(n)) return
    setAddingDevice(true)
    try { await onDeviceAdd(n); setNewDevice('') }
    finally { setAddingDevice(false) }
  }

  const buildProjectObj = (): ProjectConfig => ({
    id: project?.id ?? uuidv4(),
    name: name.trim(),
    devices: selectedDevices,
    devicePositions,
    volumePrefix: 'Untitled',
    shootingDateStart: dateStart,
    shootingDateEnd: dateEnd,
    shootingDate: dateStart,
    destinationPaths: destinations.map((d) => d.path),
    status: project?.status ?? 'active',
    createdAt: project?.createdAt ?? Date.now()
  })

  const handleSave = async () => {
    if (!name.trim()) return
    if (dateEnd < dateStart) {
      setDateError('结束日期不能早于开始日期')
      return
    }
    setDateError('')
    setSaving(true)
    try { await onSave(buildProjectObj()) }
    finally { setSaving(false) }
  }

  const handleCreateStructure = async () => {
    if (!project?.id || !name.trim()) return
    setCreatingStructure(true)
    setStructureResult(null)
    try {
      // Save first to persist latest config before creating dirs
      await window.api.saveProject(buildProjectObj())
      const result = await window.api.createFileStructure(project.id)
      setStructureResult({ created: result.created.length, skipped: result.skipped.length, errors: result.errors })
    } finally {
      setCreatingStructure(false)
    }
  }

  const isExisting = !!project?.id

  return (
    <div className="flex flex-col gap-5">
      {/* Project name */}
      <div className="glass-card p-5">
        <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">项目名称</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="输入项目名称，如 城市探店自贡"
          className="w-full bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-gray-200 placeholder-gray-600
            focus:outline-none focus:border-blue-500 transition-colors"
        />
      </div>

      {/* Shooting plan (date range) */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Calendar size={14} className="text-gray-400" />
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">拍摄计划</label>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={dateStart}
            onChange={(e) => {
              setDateStart(e.target.value)
              if (e.target.value > dateEnd) setDateEnd(e.target.value)
            }}
            className="flex-1 bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-gray-200
              focus:outline-none focus:border-blue-500 transition-colors [color-scheme:dark]"
          />
          <span className="text-gray-600 text-sm shrink-0">至</span>
          <input
            type="date"
            value={dateEnd}
            min={dateStart}
            onChange={(e) => { setDateEnd(e.target.value); setDateError('') }}
            className="flex-1 bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-gray-200
              focus:outline-none focus:border-blue-500 transition-colors [color-scheme:dark]"
          />
        </div>
        {dateError && <p className="text-xs text-red-400 mt-1.5">{dateError}</p>}
      </div>

      {/* Device management */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Cpu size={14} className="text-gray-400" />
          <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">拍摄设备管理</label>
        </div>
        <div className="flex flex-col gap-2 mb-3">
          {allDevices.length === 0 && <p className="text-xs text-gray-500">暂无设备，请添加</p>}
          {allDevices.map((d) => (
            <DeviceRow key={d} device={d} onRename={onDeviceRename} onRemove={onDeviceRemove} />
          ))}
        </div>
        <div className="flex gap-2 mb-4">
          <input
            type="text"
            value={newDevice}
            onChange={(e) => setNewDevice(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddDevice()}
            placeholder="添加设备，如 FX3、A机"
            className="flex-1 bg-[#111] border border-[#2a2a2a] rounded-xl px-3 py-2 text-sm text-gray-200 placeholder-gray-600
              focus:outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={handleAddDevice}
            disabled={addingDevice || !newDevice.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-gray-400
              hover:border-blue-500/50 hover:text-blue-400 transition-colors disabled:opacity-50"
          >
            <Plus size={13} />添加
          </button>
        </div>

        {/* Device selection + sub-positions */}
        <label className="block text-xs text-gray-500 mb-2">为该项目选择设备及子分组</label>
        {allDevices.length === 0 ? (
          <p className="text-xs text-gray-600">请先添加设备</p>
        ) : (
          <div className="flex flex-col gap-2">
            {allDevices.map((d) => {
              const checked = selectedDevices.includes(d)
              return (
                <div key={d}>
                  <button
                    onClick={() => toggleDevice(d)}
                    className={`px-4 py-2 rounded-xl border text-sm font-medium transition-all
                      ${checked
                        ? 'bg-blue-600/15 border-blue-500/40 text-blue-300'
                        : 'bg-[#111] border-[#2a2a2a] text-gray-500 hover:border-[#3a3a3a]'
                      }`}
                  >
                    {d}
                  </button>
                  {checked && (
                    <PositionManager
                      device={d}
                      positions={devicePositions[d] ?? []}
                      onChange={updatePositions}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Destinations */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <HardDrive size={14} className="text-gray-400" />
            <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">备份目的地</label>
          </div>
          <span className="text-xs text-gray-600">{destinations.length} 个</span>
        </div>
        <div className="flex flex-col gap-2 mb-3">
          {destinations.map((dest) => (
            <div key={dest.id} className="flex items-center gap-3 bg-[#111] border border-[#2a2a2a] rounded-xl px-4 py-3">
              <FolderOpen size={14} className="text-green-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200 truncate">{dest.path}</p>
                {dest.driveInfo && (
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1 bg-[#2a2a2a] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500/60 rounded-full"
                        style={{ width: `${(dest.driveInfo.used / dest.driveInfo.total) * 100}%` }}
                      />
                    </div>
                    <span className="text-xs text-gray-500 shrink-0">剩余 {formatBytes(dest.driveInfo.free)}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => setDestinations((prev) => prev.filter((d) => d.id !== dest.id))}
                className="p-1.5 text-gray-600 hover:text-red-400 transition-colors shrink-0"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        <button
          onClick={addDest}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-[#2a2a2a] text-gray-500
            hover:border-[#444] hover:text-gray-400 transition-all text-sm"
        >
          <Plus size={15} />添加目的地
        </button>

        {/* Directory structure preview */}
        {name.trim() && dateStart && selectedDevices.length > 0 && destinations.length > 0 && (
          <div className="mt-4 p-3 bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl">
            <p className="text-xs text-gray-500 mb-2">目录结构预览</p>
            {destinations.slice(0, 1).map((dest) =>
              selectedDevices.slice(0, 2).map((dev) => {
                const dateStr = dateStart.replace(/-/g, '')
                const folder = `${dateStr}${name.trim()}`
                const positions = devicePositions[dev] ?? []
                return (
                  <div key={dev}>
                    <p className="text-xs text-gray-400 font-mono truncate">
                      {dest.path}/{folder}/{dateStr}/{dev}/{positions.length > 0 ? `{${positions.join('|')}}` : ''}
                    </p>
                  </div>
                )
              })
            )}
            {(destinations.length > 1 || selectedDevices.length > 2) && (
              <p className="text-xs text-gray-600 mt-1">
                共 {destinations.length} 目的地 × {selectedDevices.length} 设备
              </p>
            )}
          </div>
        )}
      </div>

      {/* Structure creation result */}
      {structureResult && (
        <div className={`glass-card p-4 border ${structureResult.errors.length > 0 ? 'border-red-500/30' : 'border-green-500/30'}`}>
          <p className={`text-xs font-semibold mb-1 ${structureResult.errors.length > 0 ? 'text-red-400' : 'text-green-400'}`}>
            {structureResult.errors.length > 0 ? '创建完成（有错误）' : '文件结构创建成功'}
          </p>
          <p className="text-xs text-gray-400">新建 {structureResult.created} 个目录，跳过 {structureResult.skipped} 个已存在</p>
          {structureResult.errors.map((e, i) => (
            <p key={i} className="text-xs text-red-400 mt-0.5">{e}</p>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={onCancel}
          className="flex-1 py-3 rounded-xl border border-[#2a2a2a] text-sm text-gray-500 hover:text-gray-300 hover:border-[#3a3a3a] transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !name.trim()}
          className={`flex items-center justify-center gap-2 flex-1 py-3 rounded-xl font-semibold text-sm transition-all
            ${name.trim() && !saving
              ? 'bg-[#1a1a1a] border border-[#3a3a3a] text-gray-300 hover:border-blue-500/50 hover:text-blue-300'
              : 'bg-[#1a1a1a] text-gray-600 border border-[#2a2a2a] cursor-not-allowed'
            }`}
        >
          <Save size={14} />
          {saving ? '保存中...' : isExisting ? '保存更改' : '创建项目'}
        </button>
        {isExisting && (
          <button
            onClick={handleCreateStructure}
            disabled={creatingStructure || !name.trim() || destinations.length === 0}
            className={`flex items-center justify-center gap-2 flex-1 py-3 rounded-xl font-semibold text-sm transition-all
              ${!creatingStructure && name.trim() && destinations.length > 0
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-[#1a1a1a] text-gray-600 border border-[#2a2a2a] cursor-not-allowed'
              }`}
          >
            <FolderPlus size={14} />
            {creatingStructure ? '创建中...' : '创建文件结构'}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Project card (card view) ─────────────────────────────────────────────────
function ProjectCard({
  project, onEdit, onArchive, onDelete
}: {
  project: ProjectConfig
  onEdit: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const archived = project.status === 'archived'
  const dateRange = project.shootingDateStart
    ? project.shootingDateEnd && project.shootingDateEnd !== project.shootingDateStart
      ? `${project.shootingDateStart} 至 ${project.shootingDateEnd}`
      : project.shootingDateStart
    : project.shootingDate

  return (
    <div className={`glass-card p-4 flex flex-col gap-3 ${archived ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-200 leading-tight">{project.name}</p>
          {dateRange && <p className="text-xs text-gray-500 mt-0.5">{dateRange}</p>}
        </div>
        {archived && (
          <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">已归档</span>
        )}
      </div>
      {project.devices.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {project.devices.map((d) => (
            <span key={d} className="text-xs px-2 py-0.5 rounded-lg bg-blue-600/10 text-blue-400 border border-blue-500/20">{d}</span>
          ))}
        </div>
      )}
      {project.destinationPaths && project.destinationPaths.length > 0 && (
        <p className="text-xs text-gray-600 truncate">{project.destinationPaths[0]}{project.destinationPaths.length > 1 ? ` +${project.destinationPaths.length - 1}` : ''}</p>
      )}
      <div className="flex items-center gap-2 pt-1 border-t border-[#1e1e1e]">
        <button onClick={onEdit} className="flex-1 text-xs text-gray-500 hover:text-blue-400 transition-colors py-1">编辑</button>
        <button onClick={onArchive} className="flex-1 text-xs text-gray-500 hover:text-amber-400 transition-colors py-1">
          {archived ? '恢复' : '归档'}
        </button>
        <button onClick={onDelete} className="flex-1 text-xs text-gray-500 hover:text-red-400 transition-colors py-1">删除</button>
      </div>
    </div>
  )
}

// ─── Project list row (list view) ─────────────────────────────────────────────
function ProjectRow({
  project, selected, onSelect, onArchive, onDelete
}: {
  project: ProjectConfig
  selected: boolean
  onSelect: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const archived = project.status === 'archived'
  const dateRange = project.shootingDateStart
    ? project.shootingDateEnd && project.shootingDateEnd !== project.shootingDateStart
      ? `${project.shootingDateStart} 至 ${project.shootingDateEnd}`
      : project.shootingDateStart
    : (project.shootingDate || '未设计划')

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all
        ${selected ? 'bg-blue-600/10 border-blue-500/30' : 'bg-[#111] border-[#2a2a2a] hover:border-[#3a3a3a]'}
        ${archived ? 'opacity-50' : ''}`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200 font-medium truncate">{project.name}</p>
        <p className="text-xs text-gray-500 mt-0.5">{dateRange} · {project.devices.join(' / ') || '无设备'}</p>
      </div>
      {archived && (
        <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">归档</span>
      )}
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button onClick={onArchive} title={archived ? '恢复' : '归档'} className="p-1.5 text-gray-600 hover:text-amber-400 transition-colors">
          {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
        <button onClick={onDelete} title="删除" className="p-1.5 text-gray-600 hover:text-red-400 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

// ─── Tutorial modal ───────────────────────────────────────────────────────────
function TutorialModal({ onClose }: { onClose: () => void }): JSX.Element {
  const steps = [
    {
      title: '第一步：创建项目',
      desc: '在项目管理中新建项目，填写项目名称（如「城市探店自贡」）和拍摄日期范围（如 2026-04-20 至 2026-04-25）。',
      example: '项目名: 城市探店自贡\n拍摄计划: 2026-04-20 → 2026-04-25'
    },
    {
      title: '第二步：配置设备与机位',
      desc: '添加摄影机名称（如 A机、B机），并为每台机器配置子位置（如 A机下设 A、B 两个机位）。',
      example: 'A机 → 子位置: A, B\nB机 → 子位置: (无)'
    },
    {
      title: '第三步：设置备份目的地',
      desc: '添加备份硬盘路径（如 /Volumes/Archive）。可添加多个目的地实现一对多同步备份。',
      example: '目的地: /Volumes/Archive\n目的地: /Volumes/Backup2'
    },
    {
      title: '第四步：创建文件结构',
      desc: '保存项目后，点击「创建文件结构」按钮，系统将按日期×设备×机位自动在所有目的地创建目录树。',
      example: '/Volumes/Archive/\n  20260420城市探店自贡/\n    20260420/\n      A机/A/\n      A机/B/\n      B机/'
    },
    {
      title: '第五步：高级模式备份',
      desc: '在新建任务中切换「高级模式」，选择关联项目、拍摄日期、机位和子位置，系统自动解析目标路径并开始备份。卷名格式为「前缀_时间戳」。',
      example: '项目: 城市探店自贡\n日期: 2026-04-20 | 机位: A机 | 位置: A\n→ 自动目标: /Volumes/Archive/20260420城市探店自贡/20260420/A机/A/\n→ 卷名: SonyA7IV_202604201435'
    }
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-lg mx-4 bg-[#141414] border border-[#2a2a2a] rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1e1e1e]">
          <div className="flex items-center gap-2">
            <HelpCircle size={16} className="text-blue-400" />
            <span className="text-sm font-semibold text-gray-200">使用指南</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors">
            <X size={15} />
          </button>
        </div>
        <div className="overflow-y-auto max-h-[70vh] p-6 flex flex-col gap-5">
          {steps.map((step, i) => (
            <div key={i} className="flex gap-3">
              <div className="shrink-0 w-6 h-6 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-xs font-bold text-blue-400">
                {i + 1}
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
          <p className="text-xs text-gray-600 text-center">点击空白处关闭 · 简单模式无需关联项目，直接选源和目的地即可</p>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function ProjectManager(): JSX.Element {
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [devices, setDevices] = useState<string[]>([])
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  const [editing, setEditing] = useState<Partial<ProjectConfig> | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [showTutorial, setShowTutorial] = useState(false)

  useEffect(() => {
    window.api.getProjects().then(setProjects)
    window.api.getDevices().then(setDevices)
  }, [])

  const reload = async () => { const updated = await window.api.getProjects(); setProjects(updated) }
  const reloadDevices = async () => { const updated = await window.api.getDevices(); setDevices(updated) }

  const handleSave = async (project: ProjectConfig) => {
    const updated = await window.api.saveProject(project)
    setProjects(updated)
    setEditing(null)
    setIsCreating(false)
  }

  const handleArchive = async (project: ProjectConfig) => {
    const next: ProjectConfig = { ...project, status: project.status === 'archived' ? 'active' : 'archived' }
    await window.api.saveProject(next)
    await reload()
    if (selectedId === project.id) setEditing({ ...next })
  }

  const handleDelete = async (projectId: string) => {
    await window.api.deleteProject(projectId)
    await reload()
    if (selectedId === projectId) { setEditing(null); setSelectedId(null) }
  }

  const handleSelectForEdit = (project: ProjectConfig) => {
    setSelectedId(project.id)
    setEditing({ ...project })
    setIsCreating(false)
  }

  const handleNew = () => { setEditing(null); setIsCreating(true); setSelectedId(null) }
  const handleCancel = () => { setEditing(null); setIsCreating(false); setSelectedId(null) }

  const handleDeviceAdd = async (name: string) => { await window.api.addDevice(name); await reloadDevices() }
  const handleDeviceRemove = async (name: string) => { await window.api.removeDevice(name); await reloadDevices() }
  const handleDeviceRename = async (o: string, n: string) => { await window.api.renameDevice(o, n); await reloadDevices() }

  const visibleProjects = projects.filter((p) => showArchived || p.status !== 'archived')
  const archivedCount = projects.filter((p) => p.status === 'archived').length
  const showPanel = isCreating || (editing !== null)

  return (
    <div className="flex flex-1 overflow-hidden">
      {showTutorial && <TutorialModal onClose={() => setShowTutorial(false)} />}
      {/* Left: project list */}
      <div className="flex flex-col w-72 border-r border-[#1e1e1e] h-full overflow-hidden">
        <div className="flex items-center justify-between px-4 py-4 border-b border-[#1e1e1e] shrink-0">
          <span className="text-sm font-semibold text-gray-300">项目管理</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowTutorial(true)}
              className="p-1.5 rounded-lg text-gray-600 hover:text-blue-400 transition-colors"
              title="使用指南"
            >
              <HelpCircle size={14} />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg transition-colors ${viewMode === 'list' ? 'text-blue-400 bg-blue-600/10' : 'text-gray-600 hover:text-gray-400'}`}
              title="列表视图"
            >
              <LayoutList size={14} />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg transition-colors ${viewMode === 'grid' ? 'text-blue-400 bg-blue-600/10' : 'text-gray-600 hover:text-gray-400'}`}
              title="卡片视图"
            >
              <LayoutGrid size={14} />
            </button>
          </div>
        </div>

        <div className="px-3 pt-3 shrink-0">
          <button
            onClick={handleNew}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-[#2a2a2a] text-xs text-gray-500
              hover:border-blue-500/40 hover:text-blue-400 transition-all"
          >
            <Plus size={13} />新建项目
          </button>
        </div>

        {archivedCount > 0 && (
          <div className="px-3 pt-2 shrink-0">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              <span>{showArchived ? '隐藏归档' : `显示归档 (${archivedCount})`}</span>
              <Archive size={12} />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3">
          {visibleProjects.length === 0 ? (
            <p className="text-xs text-gray-600 text-center mt-8">暂无项目，点击上方新建</p>
          ) : viewMode === 'list' ? (
            <div className="flex flex-col gap-2">
              {visibleProjects.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  selected={selectedId === p.id}
                  onSelect={() => handleSelectForEdit(p)}
                  onArchive={() => handleArchive(p)}
                  onDelete={() => handleDelete(p.id)}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {visibleProjects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onEdit={() => handleSelectForEdit(p)}
                  onArchive={() => handleArchive(p)}
                  onDelete={() => handleDelete(p.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: edit panel */}
      <div className="flex-1 overflow-y-auto p-6">
        {showPanel ? (
          <div className="max-w-xl mx-auto w-full">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-5">
              {isCreating ? '新建项目' : `编辑「${editing?.name || ''}」`}
            </p>
            <ProjectEditPanel
              project={isCreating ? null : editing}
              allDevices={devices}
              onSave={handleSave}
              onCancel={handleCancel}
              onDeviceAdd={handleDeviceAdd}
              onDeviceRemove={handleDeviceRemove}
              onDeviceRename={handleDeviceRename}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-12 h-12 rounded-2xl bg-[#1a1a1a] flex items-center justify-center mb-4">
              <FolderOpen size={22} className="text-gray-600" />
            </div>
            <p className="text-sm text-gray-500">从左侧选择项目编辑，或新建一个</p>
          </div>
        )}
      </div>
    </div>
  )
}
