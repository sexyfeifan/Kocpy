import { useTaskStore } from '../../store/taskStore'
import { TaskCard } from '../components/TaskCard'
import { formatBytes } from '../../utils'
import { t } from '../../locales'
import { useEffect, useState, useCallback, useRef } from 'react'
import type { VolumeInfo } from '../../types'

// ── Shared card style ───────────────────────────────────────────────────

const CARD_STYLE: React.CSSProperties = {
  background: 'var(--color-background-card, #181818)',
  border: '1px solid var(--color-border, rgba(255,255,255,0.1))',
  borderRadius: 'var(--radius-element, 12px)',
  padding: 'var(--spacing-4, 16px)',
}

export function Dashboard(): JSX.Element {
  const { tasks, setActivePage } = useTaskStore()

  const running = tasks.filter((t) => t.status === 'running' || t.status === 'verifying')
  const completed = tasks.filter((t) => t.status === 'completed')
  const failed = tasks.filter((t) => t.status === 'failed')
  const totalBytes = completed.reduce((s, t) => s + t.totalBytes, 0)

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      {/* Stats grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12,
        marginBottom: 16,
      }}>
        <StatCard label={t('dashboard.running')} value={String(running.length)} color="#3B82F6" />
        <StatCard label={t('dashboard.completed')} value={String(completed.length)} color="#10B981" />
        <StatCard label={t('dashboard.failed')} value={String(failed.length)} color="#EF4444" />
        <StatCard label={t('dashboard.totalData')} value={formatBytes(totalBytes)} color="var(--color-text-secondary, #9CA3AF)" />
      </div>

      {/* Connected drives */}
      <ConnectedDrives />

      {/* Active tasks */}
      {running.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h2 style={{
            fontSize: 'var(--font-size-sm, 12px)',
            fontWeight: 'var(--font-weight-semibold, 600)',
            color: 'var(--color-text-disabled, #4B5563)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 12,
            marginTop: 0,
          }}>{t('dashboard.active')}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {running.map((task) => <TaskCard key={task.id} task={task} />)}
          </div>
        </div>
      )}

      {/* All tasks or empty state */}
      {tasks.length > 0 ? (
        <div>
          <h2 style={{
            fontSize: 'var(--font-size-sm, 12px)',
            fontWeight: 'var(--font-weight-semibold, 600)',
            color: 'var(--color-text-disabled, #4B5563)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 12,
            marginTop: 0,
          }}>{t('dashboard.allTasks')}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {tasks
              .filter((t) => t.status !== 'running' && t.status !== 'verifying')
              .map((task) => <TaskCard key={task.id} task={task} />)}
          </div>
        </div>
      ) : (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: 280,
          textAlign: 'center',
        }}>
          <div style={{
            width: 56,
            height: 56,
            borderRadius: 'var(--radius-element, 12px)',
            background: 'var(--color-background-muted, rgba(255,255,255,0.04))',
            border: '1px solid var(--color-border, rgba(255,255,255,0.08))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-disabled, #4B5563)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="12" x2="2" y2="12" />
              <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
            </svg>
          </div>
          <p style={{ color: 'var(--color-text-secondary, #9CA3AF)', fontWeight: 'var(--font-weight-medium, 500)', marginBottom: 4, fontSize: 'var(--font-size-base, 14px)' }}>
            {t('dashboard.empty')}
          </p>
          <p style={{ color: 'var(--color-text-disabled, #4B5563)', fontSize: 'var(--font-size-sm, 12px)', marginBottom: 16 }}>
            {t('dashboard.emptyDesc')}
          </p>
          <button
            onClick={() => setActivePage('new')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: '#3B82F6',
              color: 'white',
              border: 'none',
              borderRadius: 'var(--radius-inner, 8px)',
              fontSize: 'var(--font-size-base, 14px)',
              fontWeight: 'var(--font-weight-medium, 500)',
              cursor: 'pointer',
              transition: 'background var(--duration-fast, 175ms)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#2563EB' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#3B82F6' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            {t('dashboard.newTask')}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Stat card ───────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={CARD_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: 'var(--radius-full, 9999px)', background: color }} />
        <span style={{ fontSize: 'var(--font-size-sm, 12px)', color: 'var(--color-text-disabled, #4B5563)' }}>{label}</span>
      </div>
      <span style={{
        fontSize: 32,
        fontWeight: 'var(--font-weight-bold, 700)',
        color,
        lineHeight: 1.1,
      }}>{value}</span>
    </div>
  )
}

// ── Connected drives ────────────────────────────────────────────────────

function ConnectedDrives(): JSX.Element {
  const [volumes, setVolumes] = useState<VolumeInfo[]>([])
  const [open, setOpen] = useState(false)
  const [ejecting, setEjecting] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const vols = await window.api.listVolumes()
    setVolumes(vols)
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleEject = async (vol: VolumeInfo) => {
    setEjecting(vol.path)
    const ok = await window.api.ejectVolume(vol.path)
    if (ok) {
      await refresh()
    }
    setEjecting(null)
  }

  if (volumes.length === 0) return <></>

  const sourceCount = volumes.filter((v) => v.deviceType === 'source').length
  const destCount = volumes.filter((v) => v.deviceType === 'destination').length

  return (
    <div style={{ marginBottom: 16, position: 'relative' }} ref={panelRef}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px',
            background: 'var(--color-background-card, #141414)',
            border: '1px solid var(--color-border, rgba(255,255,255,0.08))',
            borderRadius: 'var(--radius-inner, 8px)',
            color: 'var(--color-text-secondary, #9CA3AF)',
            fontSize: 'var(--font-size-base, 14px)',
            cursor: 'pointer',
            transition: 'border-color var(--duration-fast, 175ms)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-emphasized, rgba(255,255,255,0.15))' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border, rgba(255,255,255,0.08))' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-disabled, #4B5563)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="12" x2="2" y2="12" /><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" /></svg>
          <span>{t('dashboard.connected')} {volumes.length} {t('dashboard.storageDevices')}</span>
          {sourceCount > 0 && <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(245,158,11,0.15)', color: '#F59E0B', border: '1px solid rgba(245,158,11,0.25)' }}>{sourceCount}</span>}
          {destCount > 0 && <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(59,130,246,0.15)', color: '#60A5FA', border: '1px solid rgba(59,130,246,0.25)' }}>{destCount}</span>}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-disabled, #4B5563)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--duration-fast, 175ms)' }}><polyline points="6 9 12 15 18 9" /></svg>
        </button>
      </div>

      {open && (
        <div style={{
          position: 'absolute',
          left: 0,
          top: '100%',
          marginTop: 6,
          zIndex: 40,
          minWidth: 420,
          background: 'var(--color-background-popover, #1E1E1E)',
          border: '1px solid var(--color-border, rgba(255,255,255,0.08))',
          borderRadius: 'var(--radius-element, 12px)',
          boxShadow: 'var(--shadow-high, 0 8px 24px rgba(0,0,0,0.3))',
          padding: 12,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {volumes.map((vol) => {
              const usedPct = vol.total > 0 ? (vol.used / vol.total) * 100 : 0
              const typeLabel = vol.deviceType === 'system' ? t('dashboard.system') :
                               vol.deviceType === 'source' ? t('dashboard.source') : t('dashboard.destination')
              const typeColor = vol.deviceType === 'source' ? '#F59E0B' :
                               vol.deviceType === 'destination' ? '#60A5FA' : '#6B7280'
              return (
                <div key={vol.path} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  padding: '10px 12px',
                  background: 'var(--color-background-muted, rgba(255,255,255,0.04))',
                  border: '1px solid var(--color-border, rgba(255,255,255,0.08))',
                  borderRadius: 'var(--radius-inner, 8px)',
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-disabled, #4B5563)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="12" x2="2" y2="12" /><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" /></svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: 'var(--font-size-base, 14px)', fontWeight: 'var(--font-weight-medium, 500)', color: 'var(--color-text-primary, #E5E7EB)' }}>{vol.name}</span>
                        <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: `${typeColor}22`, color: typeColor, border: `1px solid ${typeColor}44` }}>{typeLabel}</span>
                      </div>
                      <span style={{ fontSize: 'var(--font-size-sm, 12px)', color: 'var(--color-text-disabled, #4B5563)', flexShrink: 0 }}>
                        {formatBytes(vol.free)} 可用 / {formatBytes(vol.total)}
                      </span>
                    </div>
                    <div className="kocpy-progress-track">
                      <div
                        className="kocpy-progress-fill"
                        style={{
                          width: `${usedPct}%`,
                          background: usedPct > 85 ? '#EF4444' : usedPct > 60 ? '#F59E0B' : '#3B82F6',
                        }}
                      />
                    </div>
                  </div>
                  {vol.canEject && (
                    <button
                      onClick={() => handleEject(vol)}
                      disabled={ejecting === vol.path}
                      style={{
                        padding: 6,
                        background: 'transparent',
                        border: 'none',
                        borderRadius: 'var(--radius-inner, 8px)',
                        color: 'var(--color-text-disabled, #4B5563)',
                        cursor: 'pointer',
                        transition: 'color var(--duration-fast, 175ms)',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = '#F59E0B' }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-disabled, #4B5563)' }}
                      title={t('dashboard.eject')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 18H7l5-10z" /><line x1="2" y1="21" x2="22" y2="21" /></svg>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
