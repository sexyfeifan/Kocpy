import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Dashboard } from './pages/Dashboard'
import { NewTask } from './pages/NewTask'
import { History } from './pages/History'
import { Settings } from './pages/Settings'
import { NASManager } from './pages/NASManager'
import { LifecycleManager } from './pages/LifecycleManager'
import { ProjectManager } from './pages/ProjectManager'
import { useTaskStore } from './store/taskStore'

export function App(): JSX.Element {
  const { activePage, applyProgress, refreshTasks, loadProjects } = useTaskStore()

  useEffect(() => {
    refreshTasks()
    loadProjects()
    const cleanup = window.api.onProgress((payload) => {
      applyProgress(payload)
    })
    return cleanup
  }, [])

  const page =
    activePage === 'dashboard' ? <Dashboard /> :
    activePage === 'new'       ? <NewTask /> :
    activePage === 'history'   ? <History /> :
    activePage === 'projects'  ? <ProjectManager /> :
    activePage === 'settings'  ? <Settings /> :
    activePage === 'nas'       ? <NASManager /> :
    activePage === 'lifecycle' ? <LifecycleManager /> :
    <Dashboard />

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-gray-100 overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Header />
        <ErrorBoundary>
          {page}
        </ErrorBoundary>
      </div>
    </div>
  )
}
