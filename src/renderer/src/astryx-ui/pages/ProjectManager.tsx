import { Card, Button, TextInput, Switch, Badge, VStack, HStack, Divider, EmptyState } from '@astryxdesign/core'
import { useState, useEffect, useMemo } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { ProjectConfig } from '../../types'
import { todayLocal, formatBytes } from '../../utils'
import { t } from '../../locales'

export function ProjectManager(): JSX.Element {
  const [projects, setProjects] = useState<ProjectConfig[]>([])
  const [devices, setDevices] = useState<string[]>([])
  const [editing, setEditing] = useState<Partial<ProjectConfig> | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    window.api.getProjects().then(setProjects)
    window.api.getDevices().then(setDevices)
  }, [])

  const reload = async () => setProjects(await window.api.getProjects())
  const reloadDevices = async () => setDevices(await window.api.getDevices())

  const handleSave = async (project: ProjectConfig) => {
    const updated = await window.api.saveProject(project)
    setProjects(updated)
    setEditing(null)
    setIsCreating(false)
  }

  const handleArchive = async (project: ProjectConfig) => {
    const next = { ...project, status: project.status === 'archived' ? 'active' as const : 'archived' as const }
    await window.api.saveProject(next)
    await reload()
    if (selectedId === project.id) setEditing({ ...next })
  }

  const handleDelete = async (id: string) => {
    await window.api.deleteProject(id)
    await reload()
    if (selectedId === id) { setEditing(null); setSelectedId(null) }
  }

  const visibleProjects = projects.filter((p) => showArchived || p.status !== 'archived')
  const archivedCount = projects.filter((p) => p.status === 'archived').length
  const showPanel = isCreating || editing !== null

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Left: project list */}
      <div style={{ display: 'flex', flexDirection: 'column', width: 288, borderRight: '1px solid var(--color-border)', height: '100%', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
          <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)' }}>项目管理</span>
        </div>

        <div style={{ padding: '12px 12px 0', flexShrink: 0 }}>
          <Button
            label="新建项目"
            variant="secondary"
            icon={<PlusIcon />}
            onClick={() => { setEditing(null); setIsCreating(true); setSelectedId(null) }}
            style={{ width: '100%', borderStyle: 'dashed' }}
          />
        </div>

        {archivedCount > 0 && (
          <div style={{ padding: '8px 12px', flexShrink: 0 }}>
            <Button
              label={showArchived ? '隐藏归档' : `显示归档 (${archivedCount})`}
              variant="ghost"
              size="sm"
              onClick={() => setShowArchived((v) => !v)}
              style={{ width: '100%', justifyContent: 'space-between' }}
            />
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {visibleProjects.length === 0 ? (
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', textAlign: 'center', marginTop: 32 }}>暂无项目</p>
          ) : (
            <VStack spacing={2}>
              {visibleProjects.map((p) => {
                const selected = selectedId === p.id
                const archived = p.status === 'archived'
                const dateRange = p.shootingDateStart
                  ? `${p.shootingDateStart}${p.shootingDateEnd && p.shootingDateEnd !== p.shootingDateStart ? ' → ' + p.shootingDateEnd : ''}`
                  : (p.shootingDate || '未设计划')
                return (
                  <Card
                    key={p.id}
                    padding={3}
                    variant={selected ? 'blue' : 'default'}
                    style={{ cursor: 'pointer', opacity: archived ? 0.5 : 1 }}
                    onClick={() => { setSelectedId(p.id); setEditing({ ...p }); setIsCreating(false) }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text-primary)' }}>{p.name}</span>
                        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', marginTop: 2 }}>{dateRange} · {p.devices.join(' / ') || '无设备'}</p>
                      </div>
                      {archived && <Badge label="归档" variant="warning" />}
                    </div>
                  </Card>
                )
              })}
            </VStack>
          )}
        </div>
      </div>

      {/* Right: edit panel */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {showPanel ? (
          <div style={{ maxWidth: 560, margin: '0 auto', width: '100%' }}>
            <ProjectEditPanel
              project={isCreating ? null : editing}
              allDevices={devices}
              onSave={handleSave}
              onCancel={() => { setEditing(null); setIsCreating(false); setSelectedId(null) }}
              onDeviceAdd={async (n) => { await window.api.addDevice(n); await reloadDevices() }}
              onDeviceRemove={async (n) => { await window.api.removeDevice(n); await reloadDevices() }}
              onDeviceRename={async (o, n) => { await window.api.renameDevice(o, n); await reloadDevices() }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', textAlign: 'center' }}>
            <EmptyState heading="从左侧选择项目编辑" description="或新建一个项目" />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Project Edit Panel ──────────────────────────────────────────────────

function ProjectEditPanel({ project, allDevices, onSave, onCancel, onDeviceAdd, onDeviceRemove, onDeviceRename }: {
  project: Partial<ProjectConfig> | null
  allDevices: string[]
  onSave: (p: ProjectConfig) => Promise<void>
  onCancel: () => void
  onDeviceAdd: (name: string) => Promise<void>
  onDeviceRemove: (name: string) => Promise<void>
  onDeviceRename: (old: string, name: string) => Promise<void>
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [dateStart, setDateStart] = useState(project?.shootingDateStart ?? project?.shootingDate ?? todayLocal())
  const [dateEnd, setDateEnd] = useState(project?.shootingDateEnd ?? project?.shootingDate ?? todayLocal())
  const [selectedDevices, setSelectedDevices] = useState<string[]>(project?.devices ?? [])
  const [devicePositions, setDevicePositions] = useState<Record<string, string[]>>(project?.devicePositions ?? {})
  const [destinations, setDestinations] = useState<Array<{ id: string; path: string }>>([])
  const [saving, setSaving] = useState(false)
  const [newDevice, setNewDevice] = useState('')

  useEffect(() => {
    if (!project?.destinationPaths?.length) return
    setDestinations(project.destinationPaths.map((p) => ({ id: uuidv4(), path: p })))
  }, [project?.id])

  const toggleDevice = (d: string) =>
    setSelectedDevices((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d])

  const buildProject = (): ProjectConfig => ({
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
    createdAt: project?.createdAt ?? Date.now(),
  })

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try { await onSave(buildProject()) }
    finally { setSaving(false) }
  }

  const handleCreateStructure = async () => {
    if (!project?.id) return
    await window.api.saveProject(buildProject())
    await window.api.createFileStructure(project.id)
  }

  const isExisting = !!project?.id

  return (
    <VStack spacing={5}>
      {/* Project name */}
      <Card padding={5}>
        <TextInput label="项目名称" value={name} onChange={setName} placeholder="输入项目名称，如 城市探店自贡" />
      </Card>

      {/* Date range */}
      <Card padding={5}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 12 }}>
          拍摄计划
        </span>
        <HStack spacing={3}>
          <TextInput label="开始日期" isLabelHidden type="text" value={dateStart} onChange={setDateStart} placeholder="YYYY-MM-DD" />
          <span style={{ color: 'var(--color-text-disabled)', alignSelf: 'center' }}>至</span>
          <TextInput label="结束日期" isLabelHidden type="text" value={dateEnd} onChange={setDateEnd} placeholder="YYYY-MM-DD" />
        </HStack>
      </Card>

      {/* Devices */}
      <Card padding={5}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 12 }}>
          拍摄设备管理
        </span>
        <VStack spacing={2}>
          {allDevices.map((d) => (
            <div key={d} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--spacing-2) var(--spacing-4)', background: 'var(--color-background-muted)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-inner)' }}>
              <HStack spacing={2}>
                <Button label={d} variant={selectedDevices.includes(d) ? 'primary' : 'ghost'} size="sm" onClick={() => toggleDevice(d)} />
              </HStack>
              <HStack spacing={1}>
                <Button label="删除" variant="ghost" size="sm" isIconOnly icon={<TrashIcon />} onClick={() => onDeviceRemove(d)} />
              </HStack>
            </div>
          ))}
        </VStack>
        <HStack spacing={2} style={{ marginTop: 12 }}>
          <TextInput label="新设备" isLabelHidden value={newDevice} onChange={setNewDevice} placeholder="如 FX3、A机" />
          <Button label="添加" variant="secondary" size="sm" isDisabled={!newDevice.trim()} onClick={async () => { if (newDevice.trim()) { await onDeviceAdd(newDevice.trim()); setNewDevice('') } }} />
        </HStack>
      </Card>

      {/* Destinations */}
      <Card padding={5}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>备份目的地</span>
          <Badge label={`${destinations.length} 个`} variant="neutral" />
        </div>
        <VStack spacing={2}>
          {destinations.map((dest) => (
            <div key={dest.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'var(--spacing-3)', background: 'var(--color-background-muted)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-inner)' }}>
              <span style={{ flex: 1, fontSize: 'var(--font-size-base)', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{dest.path}</span>
              <Button label="删除" variant="ghost" size="sm" isIconOnly icon={<TrashIcon />} onClick={() => setDestinations((prev) => prev.filter((d) => d.id !== dest.id))} />
            </div>
          ))}
        </VStack>
        <Button
          label="添加目的地"
          variant="secondary"
          icon={<PlusIcon />}
          onClick={async () => { const p = await window.api.selectDirectory(); if (p) setDestinations((prev) => [...prev, { id: uuidv4(), path: p }]) }}
          style={{ width: '100%', marginTop: 12, borderStyle: 'dashed' }}
        />
      </Card>

      {/* Actions */}
      <HStack spacing={3}>
        <Button label="取消" variant="secondary" onClick={onCancel} style={{ flex: 1 }} />
        <Button label={saving ? '保存中...' : isExisting ? '保存更改' : '创建项目'} variant="primary" isDisabled={saving || !name.trim()} onClick={handleSave} style={{ flex: 1 }} />
        {isExisting && (
          <Button label="创建文件结构" variant="primary" isDisabled={!name.trim() || destinations.length === 0} onClick={handleCreateStructure} style={{ flex: 1 }} />
        )}
      </HStack>
    </VStack>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────

function PlusIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
}
function TrashIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
}
