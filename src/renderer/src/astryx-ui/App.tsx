import { useEffect, useState } from 'react'
import { Theme } from '@astryxdesign/core/theme'
import { neutralTheme } from '@astryxdesign/theme-neutral/built'
import { useTaskStore } from '../store/taskStore'
import { AppShell } from './AppShell'

export function AstryxApp(): JSX.Element {
  const { applyProgress, refreshTasks, loadProjects } = useTaskStore()
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-astryx-theme', 'neutral')
    document.documentElement.setAttribute('data-theme', themeMode)

    refreshTasks()
    loadProjects()
    const cleanup = window.api.onProgress((payload) => {
      applyProgress(payload)
    })
    return cleanup
  }, [themeMode])

  return (
    <Theme theme={neutralTheme} mode={themeMode}>
      <AppShell themeMode={themeMode} onToggleTheme={() => setThemeMode(m => m === 'dark' ? 'light' : 'dark')} />
    </Theme>
  )
}
