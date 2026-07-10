import { useTaskStore } from '../store/taskStore'
import { Dashboard } from './pages/Dashboard'
import { NewTask } from './pages/NewTask'
import { History } from './pages/History'
import { Settings } from './pages/Settings'
import { ProjectManager } from './pages/ProjectManager'
import { AstryxSidebar } from './Sidebar'
import { AstryxHeader } from './Header'

interface Props {
  themeMode: 'dark' | 'light'
  onToggleTheme: () => void
}

export function AppShell({ themeMode, onToggleTheme }: Props): JSX.Element {
  const { activePage } = useTaskStore()

  const page =
    activePage === 'dashboard' ? <Dashboard /> :
    activePage === 'new'       ? <NewTask /> :
    activePage === 'history'   ? <History /> :
    activePage === 'projects'  ? <ProjectManager /> :
    activePage === 'settings'  ? <Settings themeMode={themeMode} onToggleTheme={onToggleTheme} /> :
    <Dashboard />

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      background: 'var(--color-background-body)',
      color: 'var(--color-text-primary)',
      overflow: 'hidden',
    }}>
      <AstryxSidebar />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <AstryxHeader />
        <main style={{ flex: 1, overflow: 'auto' }}>
          {page}
        </main>
      </div>
    </div>
  )
}
