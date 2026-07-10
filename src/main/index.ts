import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { BackupEngine } from './backup/BackupEngine'
import { sendWebhook } from './webhook'
import { loadPersistedTasks, persistTasks, loadSettings } from './storage'
import { buildBackupReport } from './report-builder'
import { registerIpcHandlers } from './ipc-handlers'
import { initLogger, logInfo } from './logger'

const backupEngine = new BackupEngine()

function createWindow(): void {
  const isDev = !app.isPackaged
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 【Fix 3】进度持久化优化：计数器，每 10 个文件才持久化一次
  let persistFileCounter = 0
  let lastPersistedStatus: string | null = null

  // #4 fix: remove any existing listener before adding new one to prevent accumulation on createWindow() calls
  backupEngine.removeAllListeners('progress')
  backupEngine.on('progress', async (payload) => {
    win.webContents.send('backup:progress', payload)

    // 【Fix 3】只在任务状态变更时全量持久化，运行中每 10 个文件增量写入一次
    const statusChanged = payload.status !== lastPersistedStatus
    if (statusChanged) {
      // 状态变更（开始/完成/失败/取消/校验中）→ 立即全量持久化
      await persistTasks(backupEngine.getAllTasks())
      lastPersistedStatus = payload.status
      persistFileCounter = 0
    } else if (payload.status === 'running') {
      // 运行中：每 10 个文件才持久化一次（减少磁盘 I/O）
      persistFileCounter++
      if (persistFileCounter >= 10) {
        await persistTasks(backupEngine.getAllTasks())
        persistFileCounter = 0
      }
    }

    if (payload.status === 'completed' || payload.status === 'failed') {
      const s = await loadSettings()
      if (s.webhookEnabled && s.webhookUrl) {
        const task = backupEngine.getTask(payload.taskId)
        if (task) {
          sendWebhook(s.webhookUrl, buildBackupReport(task)).catch((e) => console.error('Webhook failed:', e))
        }
      }
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.kocpy.app')
  initLogger()
  logInfo('Application started')

  const saved = await loadPersistedTasks()
  for (const task of saved) {
    if (task.status === 'running' || task.status === 'verifying') {
      task.status = 'failed'
      task.errorMessage = '应用异常退出，任务中断'
    }
    backupEngine.loadTask(task)
  }

  registerIpcHandlers(backupEngine)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
