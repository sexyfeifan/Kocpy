import { LayoutDashboard, Plus, Clock, Settings, HardDrive, Shield, Layers, Database, Server } from 'lucide-react'
import { useTaskStore } from '../store/taskStore'

const nav = [
  { id: 'dashboard', icon: LayoutDashboard, label: '总览' },
  { id: 'new', icon: Plus, label: '新建任务' },
  { id: 'history', icon: Clock, label: '历史记录' },
  { id: 'projects', icon: Layers, label: '项目管理' },
  { id: 'nas', icon: Server, label: 'NAS 管理' },
  { id: 'lifecycle', icon: Database, label: '生命周期' },
  { id: 'settings', icon: Settings, label: '设置' }
]

export function Sidebar(): JSX.Element {
  const { activePage, setActivePage, tasks } = useTaskStore()
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'verifying').length

  return (
    <aside className="flex flex-col w-[68px] bg-[#0f0f0f] border-r border-[#1e1e1e] h-full py-2 items-center">
      {/* App icon */}
      <div className="drag-region w-full flex justify-center pt-11 pb-6">
        <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/30">
          <HardDrive size={18} className="text-white" />
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex flex-col gap-1 w-full px-2 no-drag">
        {nav.map(({ id, icon: Icon, label }) => {
          const active = activePage === id
          return (
            <button
              key={id}
              onClick={() => setActivePage(id)}
              title={label}
              className={`relative flex flex-col items-center justify-center w-full h-12 rounded-xl transition-all duration-150 group
                ${active ? 'bg-blue-600/20 text-blue-400' : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'}`}
            >
              {id === 'new' ? (
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all
                  ${active ? 'bg-blue-600' : 'bg-[#1e1e1e] group-hover:bg-[#2a2a2a]'}`}>
                  <Icon size={15} className={active ? 'text-white' : ''} />
                </div>
              ) : (
                <Icon size={18} />
              )}
              {id === 'dashboard' && running > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
              )}
            </button>
          )
        })}
      </nav>

      <div className="flex-1" />

      {/* Security badge */}
      <div className="mb-4 no-drag" title="数据校验保护已启用">
        <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
          <Shield size={15} className="text-green-500" />
        </div>
      </div>
    </aside>
  )
}
