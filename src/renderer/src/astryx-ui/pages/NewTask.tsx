import { Card, Button, Switch, Badge, VStack, HStack, EmptyState, SegmentedControl } from '@astryxdesign/core'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTaskStore } from '../../store/taskStore'
import type { VolumeInfo } from '../../types'
import { formatBytes } from '../../utils'
import { t } from '../../locales'

type Mode = 'card' | 'mirror' | 'project'

export function NewTask(): JSX.Element {
  const { addTask, setActivePage } = useTaskStore()

  const [mode, setMode] = useState<Mode>('card')
  const [sourcePath, setSourcePath] = useState('')
  const [destinations, setDestinations] = useState<Array<{ id: string; path: string }>>([])
  const [defaultHash, setDefaultHash] = useState<'md5' | 'sha1' | 'sha256'>('md5')
  const [volumePrefix, setVolumePrefix] = useState('Untitled')
  const [isStarting, setIsStarting] = useState(false)
  const [duplicateStrategy, setDuplicateStrategy] = useState<'skip' | 'suffix'>('skip')
  const [generateThumbnails, setGenerateThumbnails] = useState(false)
  const [includeHidden, setIncludeHidden] = useState(true)
  const [fx3Rename, setFx3Rename] = useState(false)
  const [detectedSources, setDetectedSources] = useState<VolumeInfo[]>([])
  const autoDetectedRef = useRef(false)

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setDefaultHash(s.defaultHash)
      if (s.defaultDuplicateStrategy) setDuplicateStrategy(s.defaultDuplicateStrategy)
      if (s.defaultGenerateThumbnails != null) setGenerateThumbnails(s.defaultGenerateThumbnails)
    })
  }, [])

  const scanSources = useCallback(async () => {
    const vols = await window.api.listVolumes()
    setDetectedSources(vols.filter((v) => v.deviceType === 'source'))
  }, [])

  useEffect(() => {
    scanSources()
    const id = setInterval(scanSources, 5000)
    return () => clearInterval(id)
  }, [scanSources])

  useEffect(() => {
    if (mode === 'project') return
    if (sourcePath !== '' || autoDetectedRef.current) return
    if (detectedSources.length !== 1) return
    const vol = detectedSources[0]
    setSourcePath(vol.path)
    const m = vol.path.match(/^\/Volumes\/([^/]+)/)
    setVolumePrefix((m ? m[1] : vol.path.split('/').pop() || 'Untitled').replace(/_\d{12}$/, ''))
    autoDetectedRef.current = true
  }, [detectedSources, sourcePath, mode])

  const addDestination = async () => {
    const p = await window.api.selectDirectory()
    if (p) setDestinations((prev) => [...prev, { id: Math.random().toString(36).slice(2), path: p }])
  }

  const handleStart = async () => {
    if (!sourcePath || destinations.length === 0) return
    setIsStarting(true)
    try {
      const task = await window.api.createTask({
        name: '',
        sourcePath,
        devices: [],
        destinationPaths: destinations.map((d) => d.path),
        hashAlgorithm: defaultHash,
        namingTemplate: sourcePath.split('/').pop() || 'Untitled',
        shootingDate: '',
        copyMode: mode === 'mirror' ? 'mirror' : 'normal',
        duplicateStrategy,
        generateThumbnails,
        priority: false,
        fx3Rename,
        includeHidden,
      })
      addTask(task)
      await window.api.startTask(task.id)
      setActivePage('dashboard')
    } finally {
      setIsStarting(false)
    }
  }

  const pickVolume = async (vol: VolumeInfo) => {
    const picked = await window.api.selectDirectory(vol.path)
    if (!picked) return
    setSourcePath(picked)
    const m = picked.match(/^\/Volumes\/([^/]+)/)
    setVolumePrefix((m ? m[1] : picked.split('/').pop() || 'Untitled').replace(/_\d{12}$/, ''))
    autoDetectedRef.current = true
  }

  const canStart = sourcePath && destinations.length > 0

  const modeOptions = [
    { value: 'card', label: t('newTask.cardMode') },
    { value: 'mirror', label: t('newTask.mirrorMode') },
    { value: 'project', label: t('newTask.projectMode') },
  ]

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24, maxWidth: 640, margin: '0 auto', width: '100%' }}>
      <VStack spacing={5}>
        {/* Mode toggle */}
        <SegmentedControl
          label="备份模式"
          isLabelHidden
          options={modeOptions}
          value={mode}
          onChange={(v) => { setMode(v as Mode); setSourcePath(''); setDestinations([]); autoDetectedRef.current = false }}
        />

        {/* Mode description */}
        <Card padding={4} variant={mode === 'mirror' ? 'purple' : 'blue'}>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-primary)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {mode === 'card' ? '备卡模式 · Card Mode' : mode === 'mirror' ? '镜像模式 · Mirror Mode' : '项目模式 · Project Mode'}
          </div>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.43, margin: 0 }}>
            {mode === 'card' ? t('newTask.cardDesc') : mode === 'mirror' ? t('newTask.mirrorDesc') : t('newTask.projectDesc')}
          </p>
        </Card>

        {/* Source selector */}
        <Card padding={5}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-3)' }}>
            <HStack spacing={2}>
              <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {t('newTask.dataSource')}
              </span>
              {autoDetectedRef.current && sourcePath && <Badge label={t('newTask.autoDetect')} variant="warning" />}
            </HStack>
            {sourcePath && <Button label={t('newTask.clear')} variant="ghost" size="sm" onClick={() => { setSourcePath(''); autoDetectedRef.current = false; setVolumePrefix('Untitled') }} />}
          </div>

          {detectedSources.length === 0 ? (
            <Button
              label={sourcePath || t('newTask.selectFolder')}
              variant="secondary"
              icon={<FolderIcon />}
              onClick={async () => {
                const p = await window.api.selectDirectory()
                if (p) { setSourcePath(p); autoDetectedRef.current = false; const m = p.match(/^\/Volumes\/([^/]+)/); setVolumePrefix((m ? m[1] : p.split('/').pop() || 'Untitled').replace(/_\d{12}$/, '')) }
              }}
              style={{ width: '100%', justifyContent: 'flex-start' }}
            />
          ) : (
            <VStack spacing={2}>
              {detectedSources.map((vol) => {
                const isSelected = sourcePath === vol.path
                return (
                  <Button
                    key={vol.path}
                    label={`${vol.name}${vol.total > 0 ? ` (${formatBytes(vol.total)})` : ''}`}
                    variant={isSelected ? 'primary' : 'secondary'}
                    icon={<FolderIcon />}
                    onClick={() => pickVolume(vol)}
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                  />
                )
              })}
            </VStack>
          )}
        </Card>

        {/* Destinations */}
        <Card padding={5}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-3)' }}>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {t('newTask.destinations')}
            </span>
            <Badge label={`${destinations.length} 个`} variant="neutral" />
          </div>

          <VStack spacing={2}>
            {destinations.map((dest) => (
              <div key={dest.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'var(--spacing-3)', background: 'var(--color-background-muted)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-inner)' }}>
                <FolderIcon />
                <span style={{ flex: 1, fontSize: 'var(--font-size-base)', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{dest.path}</span>
                <Button label="删除" variant="ghost" size="sm" isIconOnly icon={<TrashIcon />} onClick={() => setDestinations((prev) => prev.filter((d) => d.id !== dest.id))} />
              </div>
            ))}
          </VStack>

          <Button
            label={t('newTask.addDestination')}
            variant="secondary"
            icon={<PlusIcon />}
            onClick={addDestination}
            style={{ width: '100%', marginTop: 'var(--spacing-3)', borderStyle: 'dashed' }}
          />
        </Card>

        {/* Advanced options */}
        <Card padding={5}>
          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 'var(--spacing-4)' }}>
            {t('newTask.advanced')}
          </span>
          <VStack spacing={3}>
            <Switch label={t('newTask.thumbnails')} description={t('newTask.thumbnailsDesc')} value={generateThumbnails} onChange={setGenerateThumbnails} />
            <Switch label={t('newTask.includeHidden')} description={t('newTask.includeHiddenDesc')} value={includeHidden} onChange={setIncludeHidden} />
            {mode === 'card' && <Switch label={t('newTask.fx3Rename')} description={t('newTask.fx3RenameDesc')} value={fx3Rename} onChange={setFx3Rename} />}
          </VStack>
        </Card>

        {/* Start button */}
        <Button
          label={isStarting ? t('newTask.starting') : t('newTask.start')}
          variant="primary"
          size="lg"
          isLoading={isStarting}
          isDisabled={!canStart || isStarting}
          onClick={handleStart}
          style={{ width: '100%' }}
        />

        {!canStart && (
          <p style={{ textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)' }}>
            {t('newTask.selectSourceAndDest')}
          </p>
        )}
      </VStack>
    </div>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────

function FolderIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" /></svg>
}
function PlusIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
}
function TrashIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
}
