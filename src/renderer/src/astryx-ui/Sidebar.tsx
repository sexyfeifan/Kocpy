import { useTaskStore } from '../store/taskStore'
import { t } from '../locales'

const NAV_ITEMS = [
  { id: 'dashboard', labelKey: 'nav.dashboard', icon: DashboardIcon },
  { id: 'new', labelKey: 'nav.newTask', icon: PlusIcon },
  { id: 'history', labelKey: 'nav.history', icon: ClockIcon },
  { id: 'projects', labelKey: 'nav.projects', icon: LayersIcon },
  { id: 'settings', labelKey: 'nav.settings', icon: SettingsIcon },
]

export function AstryxSidebar(): JSX.Element {
  const { activePage, setActivePage, tasks } = useTaskStore()
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'verifying').length

  return (
    <aside style={{
      display: 'flex',
      flexDirection: 'column',
      width: 200,
      background: 'var(--color-background-surface, #111111)',
      borderRight: '1px solid var(--color-border, rgba(255,255,255,0.1))',
      height: '100%',
      padding: '8px 0',
      flexShrink: 0,
    }}>
      {/* App header */}
      <div className="drag-region" style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '44px 16px 20px',
      }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: 'var(--radius-element, 12px)',
          background: '#3B82F6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontWeight: 700,
          fontSize: 14,
          flexShrink: 0,
        }}>K</div>
        <span style={{
          fontSize: 'var(--font-size-base, 14px)',
          fontWeight: 'var(--font-weight-bold, 700)',
          color: 'var(--color-text-primary, #E5E7EB)',
          letterSpacing: '-0.02em',
        }}>Kocpy</span>
      </div>

      {/* Navigation */}
      <nav className="no-drag" style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 8px', flex: 1 }}>
        {NAV_ITEMS.map(({ id, labelKey, icon: Icon }) => {
          const active = activePage === id
          return (
            <button
              key={id}
              onClick={() => setActivePage(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '10px 12px',
                border: 'none',
                borderRadius: 'var(--radius-inner, 8px)',
                background: active ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                color: active ? '#60A5FA' : 'var(--color-text-secondary, #9CA3AF)',
                fontSize: 'var(--font-size-base, 14px)',
                fontWeight: active ? 'var(--font-weight-medium, 500)' : 'var(--font-weight-normal, 400)',
                cursor: 'pointer',
                transition: 'background var(--duration-fast, 175ms) var(--ease-standard, cubic-bezier(0.24,1,0.4,1)), color var(--duration-fast, 175ms)',
                textAlign: 'left',
                position: 'relative',
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              <Icon />
              <span>{t(labelKey)}</span>
              {id === 'dashboard' && running > 0 && (
                <span style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  width: 8,
                  height: 8,
                  borderRadius: 'var(--radius-full, 9999px)',
                  background: '#3B82F6',
                }} className="kocpy-pulse" />
              )}
            </button>
          )
        })}
      </nav>

      {/* Footer — security badge */}
      <div style={{
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <div style={{
          width: 28,
          height: 28,
          borderRadius: 'var(--radius-inner, 8px)',
          background: 'rgba(16, 185, 129, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <ShieldIcon />
        </div>
        <span style={{ fontSize: 'var(--font-size-sm, 12px)', color: 'var(--color-text-disabled, #4B5563)' }}>数据校验保护</span>
      </div>
    </aside>
  )
}

// ── Inline SVG icons ───────────────────────────────────────────────────

function DashboardIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
}

function PlusIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
}

function ClockIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
}

function LayersIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
}

function SettingsIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>
}

function ShieldIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
}
