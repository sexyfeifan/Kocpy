import { useState, useEffect } from 'react'
import { useTaskStore } from '../store/taskStore'

const PAGE_TITLES: Record<string, string> = {
  dashboard: '任务总览', new: '新建备份任务', history: '历史记录', settings: '设置', projects: '项目管理'
}

export function Header(): JSX.Element {
  const { activePage, tasks } = useTaskStore()
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'verifying').length
  const completed = tasks.filter((t) => t.status === 'completed').length
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.api.getAppVersion().then((v) => setAppVersion(v))
  }, [])

  return (
    <header className="drag-region flex items-center justify-between px-6 h-14 border-b border-[#1e1e1e] bg-[#0a0a0a] shrink-0">
      <div className="flex items-center gap-3 no-drag">
        {/* macOS traffic lights spacer */}
        <div className="w-16" />
        <span className="text-sm font-bold text-gray-100 tracking-tight">Kocpy</span>
        <span className="text-[#2a2a2a]">|</span>
        <h1 className="text-sm text-gray-500">{PAGE_TITLES[activePage]}</h1>
      </div>

      <div className="flex items-center gap-3 no-drag text-xs text-gray-500">
        {running > 0 && (
          <span className="flex items-center gap-1.5 text-blue-400 font-medium">
            <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
            {running} 个任务运行中
          </span>
        )}
        {completed > 0 && (
          <span className="text-green-500">{completed} 个已完成</span>
        )}
        <span className="text-[#333]">|</span>
        <span>Kocpy {appVersion ? `v${appVersion}` : ''}</span>
      </div>
    </header>
  )
}
