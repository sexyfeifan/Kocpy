import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { BackupEngine } from './backup/BackupEngine'
import { generateReport } from './backup/ReportGenerator'
import { sendWebhook, detectPlatform } from './webhook'
import type { BackupTask, TaskConfig, ProjectConfig } from './types'

const execFileAsync = promisify(execFile)

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

function formatDate(ts?: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(startedAt?: number, completedAt?: number): string {
  if (!startedAt || !completedAt) return '-'
  const sec = Math.round((completedAt - startedAt) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}

const CIRCLE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']

function buildDirTree(fileRecords: FileRecord[]): string[] {
  const folderDirect = new Map<string, number>()
  const allFolders = new Set<string>()

  for (const f of fileRecords) {
    const rel = (f.relativePath || f.name).replace(/\\/g, '/')
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      allFolders.add(parts.slice(0, i).join('/'))
    }
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    folderDirect.set(parent, (folderDirect.get(parent) ?? 0) + f.size)
  }

  if (allFolders.size === 0) return []

  const sorted = Array.from(allFolders).sort()
  const leafSet = new Set(sorted.filter((f) => !sorted.some((g) => g.startsWith(f + '/'))))

  return sorted.map((folder) => {
    const depth = folder.split('/').length - 1
    const name = folder.split('/').pop() ?? folder
    const indent = '  ' + '  '.repeat(depth)
    const nameStr = `${name}/`
    const sizeStr = leafSet.has(folder) ? formatBytes(folderDirect.get(folder) ?? 0) : '—'
    const pad = Math.max(2, 20 - nameStr.length - depth * 2)
    return `${indent}${nameStr}${' '.repeat(pad)}${sizeStr}`
  })
}

function buildBackupReport(task: BackupTask): string {
  const ok = task.status === 'completed'
  const lines: string[] = []

  lines.push(ok ? '✅ 备份成功  Kocpy' : '❌ 备份失败  Kocpy')
  lines.push('')

  lines.push('📋 任务信息')
  lines.push(`  任务   ${task.name}`)
  lines.push(`  哈希   ${task.hashAlgorithm?.toUpperCase() ?? '-'}`)
  lines.push(`  开始   ${formatDate(task.startedAt)}`)
  lines.push(`  完成   ${formatDate(task.completedAt)}`)
  lines.push(`  耗时   ${formatDuration(task.startedAt, task.completedAt)}`)
  lines.push(`  文件   ${task.totalFiles} 个 · ${formatBytes(task.totalBytes)}`)
  if (task.errorMessage) lines.push(`  错误   ${task.errorMessage}`)

  lines.push('')
  lines.push('📂 路径')
  if (task.sourcePath) lines.push(`  🔵 来源   ${task.sourcePath}`)
  if (task.destinations?.length) {
    task.destinations.forEach((dest, i) => {
      const label = `目标${CIRCLE_NUMS[i] ?? String(i + 1)}`
      const icon = dest.verified ? '🟢' : '🔴'
      const failNote = dest.verified ? '' : '  ← 校验失败'
      lines.push(`  ${icon} ${label}  ${dest.path}${failNote}`)
    })
  }

  lines.push('')
  lines.push('🔍 校验')
  const allVerified = task.destinations?.every((d) => d.verified) ?? false
  const destSize = task.destinations?.reduce((s, d) => s + d.bytesWritten, 0) ?? 0
  if (allVerified) {
    lines.push(`  ✅ 全部通过（src ${formatBytes(task.totalBytes)} = dest ${formatBytes(destSize)}）`)
  } else {
    const failedDests = task.destinations?.filter((d) => !d.verified) ?? []
    lines.push(`  ❌ 部分失败（${failedDests.length} 个目标校验不通过）`)
  }

  const failedFiles = (task.fileRecords ?? []).filter((f) => !f.destinations.every((d) => d.verified))
  if (failedFiles.length > 0) {
    lines.push('')
    lines.push('⚠️ 失败文件')
    for (const f of failedFiles) {
      lines.push(`  ✗ ${f.relativePath || f.name}  (${formatBytes(f.size)})`)
    }
  }

  if (task.fileRecords?.length) {
    const treeLines = buildDirTree(task.fileRecords)
    if (treeLines.length > 0) {
      lines.push('')
      lines.push('📁 目录结构')
      lines.push(...treeLines)
    }
  }

  return lines.join('\n')
}

interface AppSettings {
  defaultHash: 'md5' | 'sha1' | 'sha256'
  verifyAfterCopy: boolean
  devices: string[]
  backupCount: number
  isUnlocked: boolean
  defaultDuplicateStrategy?: 'skip' | 'suffix'
  defaultGenerateThumbnails?: boolean
  webhookUrl?: string
  webhookEnabled?: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  defaultHash: 'md5',
  verifyAfterCopy: true,
  devices: ['A机', 'B机', 'C机', 'DIT'],
  backupCount: 0,
  isUnlocked: false
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function getTasksPath(): string {
  return join(app.getPath('userData'), 'tasks.json')
}

function getProjectsPath(): string {
  return join(app.getPath('userData'), 'projects.json')
}

function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

// 【Fix 4】配置备份：写入前备份为 .bak 文件（保留最近1个备份）
function backupBeforeWrite(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak')
    }
  } catch (e) {
    console.error(`Failed to backup ${filePath}:`, e)
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, filePath)
}

function saveSettings(settings: AppSettings): void {
  backupBeforeWrite(getSettingsPath())
  atomicWrite(getSettingsPath(), JSON.stringify(settings, null, 2))
}

function loadPersistedTasks(): BackupTask[] {
  try {
    const raw = fs.readFileSync(getTasksPath(), 'utf-8')
    return JSON.parse(raw) as BackupTask[]
  } catch {
    return []
  }
}

function persistTasks(tasks: BackupTask[]): void {
  try {
    backupBeforeWrite(getTasksPath())
    atomicWrite(getTasksPath(), JSON.stringify(tasks, null, 2))
  } catch (e) {
    console.error('Failed to persist tasks:', e)
  }
}

function loadProjects(): ProjectConfig[] {
  try {
    const raw = fs.readFileSync(getProjectsPath(), 'utf-8')
    return JSON.parse(raw) as ProjectConfig[]
  } catch {
    return []
  }
}

function saveProjects(projects: ProjectConfig[]): void {
  atomicWrite(getProjectsPath(), JSON.stringify(projects, null, 2))
}

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
  backupEngine.on('progress', (payload) => {
    win.webContents.send('backup:progress', payload)

    // 【Fix 3】只在任务状态变更时全量持久化，运行中每 10 个文件增量写入一次
    const statusChanged = payload.status !== lastPersistedStatus
    if (statusChanged) {
      // 状态变更（开始/完成/失败/取消/校验中）→ 立即全量持久化
      persistTasks(backupEngine.getAllTasks())
      lastPersistedStatus = payload.status
      persistFileCounter = 0
    } else if (payload.status === 'running') {
      // 运行中：每 10 个文件才持久化一次（减少磁盘 I/O）
      persistFileCounter++
      if (persistFileCounter >= 10) {
        persistTasks(backupEngine.getAllTasks())
        persistFileCounter = 0
      }
    }

    if (payload.status === 'completed' || payload.status === 'failed') {
      const s = loadSettings()
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

app.whenReady().then(() => {
  app.setAppUserModelId('com.kocpy.app')

  const saved = loadPersistedTasks()
  for (const task of saved) {
    if (task.status === 'running' || task.status === 'verifying') {
      task.status = 'failed'
      task.errorMessage = '应用异常退出，任务中断'
    }
    backupEngine.loadTask(task)
  }

  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpcHandlers(): void {
  ipcMain.handle('dialog:selectDirectory', async (_, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {})
    })
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('dialog:saveReport', async (_, taskName: string) => {
    const result = await dialog.showSaveDialog({
      defaultPath: `备份报告_${taskName}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    return result.filePath ?? null
  })

  ipcMain.handle('backup:createTask', async (_, config: TaskConfig) => {
    const task = backupEngine.createTask(config)
    persistTasks(backupEngine.getAllTasks())
    return task
  })

  ipcMain.handle('backup:startTask', async (_, taskId: string) => {
    const s = loadSettings()
    const FREE_LIMIT = 10
    if (!s.isUnlocked && (s.backupCount ?? 0) >= FREE_LIMIT) {
      return { allowed: false, remaining: 0 }
    }
    if (!s.isUnlocked) {
      s.backupCount = (s.backupCount ?? 0) + 1
      saveSettings(s)
    }
    backupEngine.startTask(taskId, { verifyAfterCopy: s.verifyAfterCopy }).catch(console.error)
    return { allowed: true, remaining: s.isUnlocked ? Infinity : FREE_LIMIT - s.backupCount }
  })

  ipcMain.handle('backup:cancelTask', async (_, taskId: string) => {
    backupEngine.cancelTask(taskId)
    return true
  })

  ipcMain.handle('backup:deleteTask', async (_, taskId: string) => {
    backupEngine.deleteTask(taskId)
    persistTasks(backupEngine.getAllTasks())
    return true
  })

  ipcMain.handle('backup:setPriority', async (_, taskId: string, priority: boolean) => {
    backupEngine.setPriority(taskId, priority)
    persistTasks(backupEngine.getAllTasks())
    return true
  })

  ipcMain.handle('backup:getTasks', async () => {
    return backupEngine.getAllTasks()
  })

  ipcMain.handle('backup:getTask', async (_, taskId: string) => {
    return backupEngine.getTask(taskId)
  })

  ipcMain.handle('backup:generateReport', async (_, taskId: string, savePath: string, options?: { includeThumbnails?: boolean }) => {
    const task = backupEngine.getTask(taskId)
    if (!task) throw new Error('Task not found')
    const htmlBuffer = await generateReport(task, options ?? {})
    const tmpPath = join(app.getPath('temp'), `report_${taskId}.html`)
    await fs.promises.writeFile(tmpPath, htmlBuffer)
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
    await win.loadFile(tmpPath)
    const pdfBuffer = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    win.destroy()
    await fs.promises.unlink(tmpPath).catch(() => {})
    await fs.promises.writeFile(savePath, Buffer.from(pdfBuffer))
    return true
  })

  ipcMain.handle('system:getDriveInfo', async (_, dirPath: string) => {
    try {
      const stat = await (fs.promises as any).statfs(dirPath)
      return {
        path: dirPath,
        total: stat.blocks * stat.bsize,
        free: stat.bfree * stat.bsize,
        used: (stat.blocks - stat.bfree) * stat.bsize
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('system:getInfo', async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem()
    }
  })

  ipcMain.handle('system:revealInFinder', async (_, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('system:listVolumes', async () => {
    if (process.platform !== 'darwin') return []
    try {
      const entries = await fs.promises.readdir('/Volumes', { withFileTypes: true })
      const volumes = await Promise.all(
        entries
          .filter((e) => !e.name.startsWith('.'))
          .map(async (e) => {
            const volPath = `/Volumes/${e.name}`
            try {
              // P0-3: 使用 execFile 避免命令注入
              const { stdout } = await execFileAsync('diskutil', ['info', volPath]).catch(() => ({ stdout: '' }))
              const isExternalSignal =
                /Device Location:\s+External/i.test(stdout) ||
                /Protocol:\s+(USB|Thunderbolt|SD Card)/i.test(stdout)
              const hasExplicitInternalSignal =
                /Protocol:\s+Apple Fabric/i.test(stdout) ||
                /Protocol:\s+PCI-Express/i.test(stdout) ||
                /Device Location:\s+Internal/i.test(stdout)
              // Only skip if explicitly internal — card readers often show no external signal
              // but should not be silently dropped
              const isInternal = !isExternalSignal && hasExplicitInternalSignal
              const isRootLink = await fs.promises.realpath(volPath).then((r) => r === '/').catch(() => false)

              // Filter out Time Machine snapshot/backup volumes
              const isTimeMachine =
                e.name.startsWith('com.apple.TimeMachine') ||
                /time[\s-]*machine/i.test(e.name) ||
                /的备份$/.test(e.name)
              if (isTimeMachine) return null

              // Macintosh HD (the root volume symlink) → return as system disk
              if (isRootLink) {
                const stat = await (fs.promises as any).statfs('/').catch(() => null)
                if (!stat) return null
                return {
                  name: 'Macintosh HD',
                  path: '/',
                  total: stat.blocks * stat.bsize,
                  free: stat.bfree * stat.bsize,
                  used: (stat.blocks - stat.bfree) * stat.bsize,
                  deviceType: 'system' as const,
                  canEject: false
                }
              }

              // Skip other internal volumes (Recovery, Preboot, etc.)
              if (isInternal) return null

              const stat = await (fs.promises as any).statfs(volPath)
              const total: number = stat.blocks * stat.bsize
              const free: number = stat.bfree * stat.bsize
              const used: number = (stat.blocks - stat.bfree) * stat.bsize

              // Multi-signal scoring model to distinguish camera cards (source) from backup drives (destination).
              // Positive score = source, negative = destination. Threshold: >= 2 → source.
              const fsType = stdout.match(/Type \(Bundle\):\s+(.+)/i)?.[1]?.trim() ?? ''
              const protocol = stdout.match(/Protocol:\s+(.+)/i)?.[1]?.trim() ?? ''
              const blockSize = parseInt(stdout.match(/Device Block Size:\s+(\d+)/i)?.[1] ?? '0', 10)
              const partScheme = stdout.match(/Partition Type:\s+(.+)/i)?.[1]?.trim() ?? ''
              const isRemovable = /Removable Media:\s+Removable/i.test(stdout)
              const volNameLower = e.name.toLowerCase()

              let score = 0

              // Protocol — strongest signal
              if (/SD Card/i.test(protocol)) score += 5          // definitely a card
              if (/PCI-Express/i.test(protocol)) score += 3       // CFexpress/XQD via PCIe reader
              if (/Thunderbolt/i.test(protocol)) score -= 3       // usually a backup drive; SxS also uses TB but name patterns catch it
              if (/USB/i.test(protocol)) score -= 1               // slight destination lean

              // File system
              if (/exfat|msdos|fat32/i.test(fsType)) score += 2  // card-typical format
              if (/apfs/i.test(fsType)) score -= 2                // macOS-formatted backup drive
              if (/ntfs/i.test(fsType)) score -= 1                // Windows backup drive

              // Block size: 512 = card/reader, 4096 = modern HDD/SSD
              if (blockSize === 512) score += 1
              if (blockSize === 4096) score -= 2

              // Partition scheme: FDisk = camera-formatted card, GUID = Mac-formatted drive
              if (/FDisk/i.test(partScheme)) score += 2
              if (/GUID/i.test(partScheme) || /Apple_partition/i.test(partScheme)) score -= 1

              // Capacity: cards rarely exceed 512 GB today
              if (total <= 512 * 1024 * 1024 * 1024) score += 1
              if (total > 1024 * 1024 * 1024 * 1024) score -= 3  // > 1 TB → almost certainly a drive

              // Removable flag (unreliable on modern readers, but counts a little when present)
              if (isRemovable) score += 1

              // Volume name patterns common on camera cards (SD, CF, CFexpress, CFast, XQD, SxS)
              if (/^[A-Z]\d{3}$/.test(e.name) || // A001, B002
                  /^(CARD|SD|CF|XQD|SXS|CFAST|CFEXPRESS|A7|SONY|CANON|NIKON|FUJI|PANA)/i.test(volNameLower) ||
                  /_(A|B|C|CAM)\d*$/i.test(volNameLower)) score += 2

              // DCIM directory presence is a strong camera-card signal
              const hasDCIM = await fs.promises.access(path.join(volPath, 'DCIM')).then(() => true).catch(() => false)
              if (hasDCIM) score += 3

              const deviceType = score >= 2 ? ('source' as const) : ('destination' as const)

              return { name: e.name, path: volPath, total, free, used, deviceType, canEject: true, _fsType: fsType }
            } catch {
              return null
            }
          })
      )
      return volumes.filter(Boolean).map(({ _fsType: _, ...v }) => v)
    } catch {
      return []
    }
  })

  ipcMain.handle('system:ejectVolume', async (_, volumePath: string) => {
    try {
      // P0-3: 使用 execFile 避免命令注入
      await execFileAsync('diskutil', ['eject', volumePath])
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('settings:get', async () => loadSettings())

  ipcMain.handle('app:getVersion', async () => app.getVersion())

  function compareVersions(a: string, b: string): number {
    const pa = a.replace(/^v/, '').split('.').map(Number)
    const pb = b.replace(/^v/, '').split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0
      const nb = pb[i] || 0
      if (na > nb) return 1
      if (na < nb) return -1
    }
    return 0
  }

  ipcMain.handle('app:checkForUpdates', async () => {
    const currentVersion = app.getVersion()
    const GITHUB_REPO = 'sexyfeifan/Kocpy'
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': `Kocpy/${currentVersion}` }
      })
      if (!res.ok) return { hasUpdate: false, error: `HTTP ${res.status}` }
      const data = await res.json() as any
      const latestVersion = (data.tag_name as string).replace(/^v/, '')
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
      const assets = (data.assets ?? []).map((a: any) => ({
        name: a.name as string,
        url: a.browser_download_url as string,
        size: a.size as number,
      }))
      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseUrl: data.html_url as string,
        releaseNotes: (data.body as string) ?? '',
        publishedAt: data.published_at as string,
        assets,
      }
    } catch (err) {
      return { hasUpdate: false, error: String(err) }
    }
  })

  ipcMain.handle('settings:save', async (_, settings: AppSettings) => {
    saveSettings(settings)
    return true
  })

  ipcMain.handle('settings:getDevices', async () => {
    return loadSettings().devices
  })

  ipcMain.handle('settings:addDevice', async (_, name: string) => {
    const s = loadSettings()
    if (!s.devices.includes(name)) {
      s.devices.push(name)
      saveSettings(s)
    }
    return s.devices
  })

  ipcMain.handle('settings:removeDevice', async (_, name: string) => {
    const s = loadSettings()
    s.devices = s.devices.filter((d) => d !== name)
    saveSettings(s)
    return s.devices
  })

  ipcMain.handle('settings:renameDevice', async (_, oldName: string, newName: string) => {
    const s = loadSettings()
    const idx = s.devices.indexOf(oldName)
    if (idx >= 0) s.devices[idx] = newName
    saveSettings(s)
    return s.devices
  })

  ipcMain.handle('projects:getAll', async () => loadProjects())

  ipcMain.handle('projects:save', async (_, project: ProjectConfig) => {
    const projects = loadProjects()
    const idx = projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) {
      projects[idx] = project
    } else {
      projects.push(project)
    }
    saveProjects(projects)
    return projects
  })

  ipcMain.handle('projects:delete', async (_, projectId: string) => {
    const projects = loadProjects().filter((p) => p.id !== projectId)
    saveProjects(projects)
    return projects
  })

  ipcMain.handle('projects:createFileStructure', async (_, projectId: string) => {
    const project = loadProjects().find((p) => p.id === projectId)
    if (!project || !project.destinationPaths?.length) {
      return { created: [], skipped: [], errors: ['项目不存在或未设置目的地'] }
    }

    const start = project.shootingDateStart ?? project.shootingDate
    const end = project.shootingDateEnd ?? project.shootingDate
    if (!start || !end) return { created: [], skipped: [], errors: ['未设置拍摄计划日期'] }

    // Enumerate all dates in range
    const dates: string[] = []
    const cur = new Date(start)
    const last = new Date(end)
    while (cur <= last) {
      const y = cur.getFullYear()
      const m = String(cur.getMonth() + 1).padStart(2, '0')
      const d = String(cur.getDate()).padStart(2, '0')
      dates.push(`${y}${m}${d}`)
      cur.setDate(cur.getDate() + 1)
    }

    const projectNameCompact = start.replace(/-/g, '') + (project.name ?? '')
    const created: string[] = []
    const skipped: string[] = []
    const errors: string[] = []

    for (const destRoot of project.destinationPaths) {
      for (const dateStr of dates) {
        const dateFolder = join(destRoot, projectNameCompact, dateStr)
        for (const device of project.devices) {
          const positions = project.devicePositions?.[device] ?? []
          if (positions.length === 0) {
            // No sub-positions: just device folder
            const target = join(dateFolder, device)
            try {
              await fs.promises.mkdir(target, { recursive: true })
              created.push(target)
            } catch (e: any) {
              if (e.code === 'EEXIST') skipped.push(target)
              else errors.push(`${target}: ${e.message}`)
            }
          } else {
            for (const pos of positions) {
              const target = join(dateFolder, device, pos)
              try {
                await fs.promises.mkdir(target, { recursive: true })
                created.push(target)
              } catch (e: any) {
                if (e.code === 'EEXIST') skipped.push(target)
                else errors.push(`${target}: ${e.message}`)
              }
            }
          }
        }
      }
    }

    return { created, skipped, errors }
  })

  ipcMain.handle('projects:resolveBackupPath', async (_, params: {
    projectId: string
    shootingDate: string
    deviceName: string
    positionLabel: string
  }) => {
    const { projectId, shootingDate, deviceName, positionLabel } = params
    const project = loadProjects().find((p) => p.id === projectId)
    if (!project || !project.destinationPaths?.length) return null

    const dateStr = shootingDate.replace(/-/g, '')
    const startStr = (project.shootingDateStart ?? project.shootingDate ?? shootingDate).replace(/-/g, '')
    const projectNameCompact = startStr + (project.name ?? '')
    return project.destinationPaths.map(dest => {
      const deviceFolder = positionLabel
        ? join(dest, projectNameCompact, dateStr, deviceName, positionLabel)
        : join(dest, projectNameCompact, dateStr, deviceName)
      return deviceFolder
    })
  })

  ipcMain.handle('settings:checkAndIncrementBackupCount', async () => {
    const s = loadSettings()
    if (s.isUnlocked) return { allowed: true, remaining: Infinity }
    const FREE_LIMIT = 10
    if (s.backupCount >= FREE_LIMIT) return { allowed: false, remaining: 0 }
    s.backupCount = (s.backupCount ?? 0) + 1
    saveSettings(s)
    return { allowed: true, remaining: FREE_LIMIT - s.backupCount }
  })

  ipcMain.handle('settings:unlock', async () => {
    const s = loadSettings()
    s.isUnlocked = true
    saveSettings(s)
    return true
  })

  ipcMain.handle('webhook:test', async (_, url: string) => {
    try {
      const platform = detectPlatform(url)
      const platformNames: Record<string, string> = {
        feishu: '飞书', dingtalk: '钉钉', wecom: '企业微信', discord: 'Discord', slack: 'Slack'
      }
      await sendWebhook(url, `[Kocpy] 测试消息 ✅ Webhook 连接正常（平台：${platformNames[platform] ?? platform}）`)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })
}
