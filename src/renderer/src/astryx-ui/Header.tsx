import { useTaskStore } from '../store/taskStore'
import { t } from '../locales'
import { useState, useEffect } from 'react'

const PAGE_TITLES: Record<string, string> = {
  dashboard: 'dashboard.title',
  new: 'newTask.cardMode',
  history: 'history.title',
  settings: 'settings.about',
  projects: 'nav.projects',
}

export function AstryxHeader(): JSX.Element {
  const { activePage, tasks } = useTaskStore()
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'verifying').length
  const completed = tasks.filter((t) => t.status === 'completed').length
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.api.getAppVersion().then((v) => setAppVersion(v))
  }, [])

  return (
    <header className="drag-region" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 56,
      padding: '0 24px',
      borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.1))',
      background: 'var(--color-background-body, #0A0A0A)',
      flexShrink: 0,
    }}>
      <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 68 }} />
        <h1 style={{
          fontSize: 'var(--font-size-base, 14px)',
          fontWeight: 'var(--font-weight-normal, 400)',
          color: 'var(--color-text-secondary, #9CA3AF)',
          margin: 0,
        }}>{t(PAGE_TITLES[activePage] ?? 'dashboard.title')}</h1>
      </div>

      <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 'var(--font-size-sm, 12px)' }}>
        {running > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#60A5FA', fontWeight: 'var(--font-weight-medium, 500)' }}>
            <span className="kocpy-pulse" style={{
              width: 6,
              height: 6,
              borderRadius: 'var(--radius-full, 9999px)',
              background: '#3B82F6',
              display: 'inline-block',
            }} />
            {running} {t('header.running')}
          </div>
        )}
        {completed > 0 && (
          <span style={{ color: 'var(--color-success, #10B981)' }}>{completed} {t('header.completed')}</span>
        )}
        <span style={{ color: 'var(--color-border, rgba(255,255,255,0.1))' }}>|</span>
        <span style={{ color: 'var(--color-text-disabled, #4B5563)', fontFamily: 'var(--font-family-code, monospace)' }}>
          v{appVersion || '…'}
        </span>
      </div>
    </header>
  )
}
