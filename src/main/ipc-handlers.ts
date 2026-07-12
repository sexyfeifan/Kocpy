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
import type { TaskConfig, ProjectConfig } from './types'
import type { AppSettings } from './storage'
import { getLogsDir } from './logger'
import {
  loadSettings,
  saveSettings,
  loadProjects,
  saveProjects,
  persistTasks
} from './storage'
import { buildBackupReport } from './report-builder'

// Type definition for statfs
interface StatFs {
  type: number
  bsize: number
  blocks: number
  bfree: number
  bavail: number
  files: number
  ffree: number
}

// Extend fs.promises with statfs type
declare module 'fs' {
  namespace promises {
    function statfs(path: string): Promise<StatFs>
  }
}

const execFileAsync = promisify(execFile)

export function registerIpcHandlers(backupEngine: BackupEngine): void {
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
    await persistTasks(backupEngine.getAllTasks())
    return task
  })

  ipcMain.handle('backup:startTask', async (_, taskId: string) => {
    const s = await loadSettings()
    backupEngine.startTask(taskId, { verifyAfterCopy: s.verifyAfterCopy })
    return { allowed: true }
  })

  ipcMain.handle('backup:cancelTask', async (_, taskId: string) => {
    backupEngine.cancelTask(taskId)
    return true
  })

  ipcMain.handle('backup:deleteTask', async (_, taskId: string) => {
    backupEngine.deleteTask(taskId)
    await persistTasks(backupEngine.getAllTasks())
    return true
  })

  ipcMain.handle('backup:setPriority', async (_, taskId: string, priority: boolean) => {
    backupEngine.setPriority(taskId, priority)
    await persistTasks(backupEngine.getAllTasks())
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
      const stat = await fs.promises.statfs(dirPath)
      return {
        path: dirPath,
        total: stat.blocks * stat.bsize,
        free: stat.bfree * stat.bsize,
        used: (stat.blocks - stat.bfree) * stat.bsize
      }
    } catch (err) {
      logWarn(`Failed to get drive info for ${dirPath}: ` + String(err))
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

  ipcMain.handle('system:openLogs', async () => {
    shell.openPath(getLogsDir())
  })

  ipcMain.handle('system:listVolumes', async () => {
    if (process.platform !== 'darwin') return []
    try {
      const volumes = []

      // 扫描 /Volumes 目录
      const entries = await fs.promises.readdir('/Volumes', { withFileTypes: true })
      const externalVolumes = await Promise.all(
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
                const stat = await fs.promises.statfs('/').catch(() => null)
                if (!stat) return null
                return {
                  name: 'Macintosh HD',
                  path: '/',
                  totalBytes: stat.blocks * stat.bsize,
                  freeBytes: stat.bfree * stat.bsize,
                  format: 'APFS',
                  deviceType: 'system' as const,
                  canEject: false
                }
              }

              // Skip other internal volumes (Recovery, Preboot, etc.)
              if (isInternal) return null

              const stat = await fs.promises.statfs(volPath)
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
            } catch (err) {
              logWarn(`Failed to process volume ${e.name}: ` + String(err))
              return null
            }
          })
      )
      const allVolumes = [...volumes, ...externalVolumes.filter(Boolean).map(({ _fsType: _, ...v }) => v)]
      return allVolumes  // 本地硬盘在前
    } catch (err) {
      logError('Failed to list volumes', err)
      return []
    }
  })

  ipcMain.handle('system:ejectVolume', async (_, volumePath: string) => {
    try {
      // Step 1: unmount the volume (works with mount paths like /Volumes/SD_CARD)
      await execFileAsync('diskutil', ['unmount', volumePath])

      // Step 2: find the parent disk identifier (e.g. disk2) so we can eject the whole disk
      const { stdout: info } = await execFileAsync('diskutil', ['info', volumePath])
      const diskNode = info.match(/Device Node:\s+(.+)/)?.[1]?.trim()
      if (diskNode) {
        await execFileAsync('diskutil', ['eject', diskNode])
      }

      return true
    } catch (err) {
      logError(`Failed to eject volume ${volumePath}`, err)
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

    // GitHub Release API response type
    interface GitHubRelease {
      tag_name: string
      html_url: string
      body: string
      published_at: string
      assets: Array<{
        name: string
        browser_download_url: string
        size: number
      }>
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': `Kocpy/${currentVersion}` }
      })
      if (!res.ok) return { hasUpdate: false, error: `HTTP ${res.status}` }
      const data = await res.json() as GitHubRelease
      const latestVersion = data.tag_name.replace(/^v/, '')
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
      const assets = data.assets.map(a => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
      }))
      return {
        hasUpdate,
        currentVersion,
        latestVersion,
        releaseUrl: data.html_url,
        releaseNotes: data.body ?? '',
        publishedAt: data.published_at,
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
    return await loadSettings().devices
  })

  ipcMain.handle('settings:addDevice', async (_, name: string) => {
    const s = await loadSettings()
    if (!s.devices.includes(name)) {
      s.devices.push(name)
      await saveSettings(s)
    }
    return s.devices
  })

  ipcMain.handle('settings:removeDevice', async (_, name: string) => {
    const s = await loadSettings()
    s.devices = s.devices.filter((d) => d !== name)
    await saveSettings(s)
    return s.devices
  })

  ipcMain.handle('settings:renameDevice', async (_, oldName: string, newName: string) => {
    const s = await loadSettings()
    const idx = s.devices.indexOf(oldName)
    if (idx >= 0) s.devices[idx] = newName
    await saveSettings(s)
    return s.devices
  })

  ipcMain.handle('projects:getAll', async () => await loadProjects())

  ipcMain.handle('projects:save', async (_, project: ProjectConfig) => {
    const projects = await loadProjects()
    const idx = projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) {
      projects[idx] = project
    } else {
      projects.push(project)
    }
    await saveProjects(projects)
    return projects
  })

  ipcMain.handle('projects:delete', async (_, projectId: string) => {
    const projects = (await loadProjects()).filter((p) => p.id !== projectId)
    await saveProjects(projects)
    return projects
  })

  ipcMain.handle('projects:createFileStructure', async (_, projectId: string) => {
    const project = (await loadProjects()).find((p) => p.id === projectId)
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
    const project = (await loadProjects()).find((p) => p.id === projectId)
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

  // ASC MHL 相关处理器
  ipcMain.handle('mhl:generate', async (_, sourcePath: string, algorithm: string, operator: string, notes?: string) => {
    try {
      const mhl = await generateMHL(sourcePath, algorithm as any, operator, notes)
      const outputPath = sourcePath + '.mhl'
      await saveMHLFile(mhl, outputPath, 'xml')
      return { success: true, outputPath, totalFiles: mhl.files.length }
    } catch (err) {
      logError('Failed to generate MHL', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('mhl:verify', async (_, mhlPath: string, targetPath: string) => {
    try {
      const result = await verifyMHL(mhlPath, targetPath)
      return { success: true, result }
    } catch (err) {
      logError('Failed to verify MHL', err)
      return { success: false, error: String(err) }
    }
  })

  // 元数据提取相关处理器
  ipcMain.handle('metadata:extract', async (_, filePath: string) => {
    try {
      const { metadataManager } = await import('./metadata')
      const metadata = await metadataManager.extractMetadata(filePath)
      return { success: true, metadata }
    } catch (err) {
      logError('Failed to extract metadata', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('metadata:extractBatch', async (_, filePaths: string[]) => {
    try {
      const { metadataManager } = await import('./metadata')
      const results = await metadataManager.extractMetadataBatch(filePaths)
      return { success: true, results: Object.fromEntries(results) }
    } catch (err) {
      logError('Failed to extract batch metadata', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('metadata:getSupportedFormats', async () => {
    try {
      const { metadataManager } = await import('./metadata')
      return metadataManager.getSupportedFormats()
    } catch (err) {
      logError('Failed to get supported formats', err)
      return []
    }
  })

  // 转码相关处理器
  ipcMain.handle('transcode:video', async (_, options: any) => {
    try {
      const { transcodeVideo } = await import('./transcode')
      const result = await transcodeVideo(options)
      return result
    } catch (err) {
      logError('Failed to transcode video', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('transcode:batch', async (_, files: any[], options: any, concurrency?: number) => {
    try {
      const { transcodeBatch } = await import('./transcode')
      const results = await transcodeBatch(files, options, concurrency)
      return { success: true, results }
    } catch (err) {
      logError('Failed to transcode batch', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('transcode:getFormats', async () => {
    try {
      const { getSupportedFormats, getFormatDescription, getResolutionDescription } = await import('./transcode')
      const formats = getSupportedFormats()
      return formats.map(f => ({
        value: f,
        label: getFormatDescription(f)
      }))
    } catch (err) {
      logError('Failed to get transcode formats', err)
      return []
    }
  })

  ipcMain.handle('transcode:getResolutions', async () => {
    try {
      const { getResolutionDescription } = await import('./transcode')
      const resolutions: Array<'4k' | '1080p' | '720p' | '480p'> = ['4k', '1080p', '720p', '480p']
      return resolutions.map(r => ({
        value: r,
        label: getResolutionDescription(r)
      }))
    } catch (err) {
      logError('Failed to get resolutions', err)
      return []
    }
  })

  // LUT/CDL 相关处理器
  ipcMain.handle('lut:import', async (_, filePath: string, name?: string, tags?: string[]) => {
    try {
      const { lutManager } = await import('./lut')
      const lut = await lutManager.importLUT(filePath, name, tags)
      return { success: true, lut }
    } catch (err) {
      logError('Failed to import LUT', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('lut:getAll', async () => {
    try {
      const { lutManager } = await import('./lut')
      return await lutManager.getLUTs()
    } catch (err) {
      logError('Failed to get LUTs', err)
      return []
    }
  })

  ipcMain.handle('lut:createCDL', async (_, name: string, slope: number[], offset: number[], power: number[], saturation: number) => {
    try {
      const { lutManager } = await import('./lut')
      const cdl = await lutManager.createCDL(name, slope as any, offset as any, power as any, saturation)
      return { success: true, cdl }
    } catch (err) {
      logError('Failed to create CDL', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('lut:getCDLs', async () => {
    try {
      const { lutManager } = await import('./lut')
      return await lutManager.getCDLs()
    } catch (err) {
      logError('Failed to get CDLs', err)
      return []
    }
  })

  ipcMain.handle('lut:exportCDL', async (_, cdlId: string, format: 'xml' | 'ccc') => {
    try {
      const { lutManager } = await import('./lut')
      const cdls = await lutManager.getCDLs()
      const cdl = cdls.find(c => c.id === cdlId)
      if (!cdl) throw new Error('CDL not found')
      
      const content = format === 'xml' 
        ? lutManager.exportCDLToXML(cdl)
        : lutManager.exportCDLToCCC(cdl)
      return { success: true, content }
    } catch (err) {
      logError('Failed to export CDL', err)
      return { success: false, error: String(err) }
    }
  })

  // DaVinci Resolve 相关处理器
  ipcMain.handle('resolve:exportALE', async (_, entries: any[], outputPath: string) => {
    try {
      const { exportALE } = await import('./resolve')
      await exportALE(entries, outputPath)
      return { success: true }
    } catch (err) {
      logError('Failed to export ALE', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('resolve:exportXML', async (_, entries: any[], outputPath: string) => {
    try {
      const { exportFCPXML } = await import('./resolve')
      await exportFCPXML(entries, outputPath)
      return { success: true }
    } catch (err) {
      logError('Failed to export XML', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('resolve:exportEDL', async (_, entries: any[], outputPath: string) => {
    try {
      const { exportEDL } = await import('./resolve')
      await exportEDL(entries, outputPath)
      return { success: true }
    } catch (err) {
      logError('Failed to export EDL', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('resolve:createProject', async (_, projectName: string, basePath: string) => {
    try {
      const { createResolveProject } = await import('./resolve')
      const result = await createResolveProject(projectName, basePath)
      return { success: true, ...result }
    } catch (err) {
      logError('Failed to create Resolve project', err)
      return { success: false, error: String(err) }
    }
  })

  // NAS 相关处理器
  ipcMain.handle('nas:scan', async () => {
    try {
      const { nasManager } = await import('./nas')
      const devices = await nasManager.scanNetwork()
      return { success: true, devices }
    } catch (err) {
      logError('Failed to scan NAS', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('nas:getDevices', async () => {
    try {
      const { nasManager } = await import('./nas')
      return nasManager.getDiscoveredDevices()
    } catch (err) {
      logError('Failed to get NAS devices', err)
      return []
    }
  })

  ipcMain.handle('nas:createSyncJob', async (_, source: string, destination: string) => {
    try {
      const { nasManager } = await import('./nas')
      const job = await nasManager.createSyncJob(source, destination)
      return { success: true, job }
    } catch (err) {
      logError('Failed to create sync job', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('nas:startSync', async (_, jobId: string) => {
    try {
      const { nasManager } = await import('./nas')
      await nasManager.startSync(jobId)
      return { success: true }
    } catch (err) {
      logError('Failed to start sync', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('nas:getSyncJobs', async () => {
    try {
      const { nasManager } = await import('./nas')
      return nasManager.getSyncJobs()
    } catch (err) {
      logError('Failed to get sync jobs', err)
      return []
    }
  })

  // 媒体生命周期相关处理器
  ipcMain.handle('lifecycle:register', async (_, filePath: string, project?: string, tags?: string[]) => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      const lifecycle = await lifecycleManager.registerMedia(filePath, project, tags)
      return { success: true, lifecycle }
    } catch (err) {
      logError('Failed to register media', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('lifecycle:updateStatus', async (_, id: string, status: string, location?: string, notes?: string) => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      await lifecycleManager.updateStatus(id, status as any, location, notes)
      return { success: true }
    } catch (err) {
      logError('Failed to update status', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('lifecycle:getAll', async () => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      return lifecycleManager.getAllLifecycles()
    } catch (err) {
      logError('Failed to get lifecycles', err)
      return []
    }
  })

  ipcMain.handle('lifecycle:search', async (_, query: string) => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      return lifecycleManager.search(query)
    } catch (err) {
      logError('Failed to search lifecycles', err)
      return []
    }
  })

  ipcMain.handle('lifecycle:getStatistics', async () => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      return lifecycleManager.getStatistics()
    } catch (err) {
      logError('Failed to get statistics', err)
      return {}
    }
  })

  ipcMain.handle('lifecycle:createArchivePolicy', async (_, policy: any) => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      const result = await lifecycleManager.createArchivePolicy(policy)
      return { success: true, policy: result }
    } catch (err) {
      logError('Failed to create archive policy', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('lifecycle:getArchivePolicies', async () => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      return lifecycleManager.getArchivePolicies()
    } catch (err) {
      logError('Failed to get archive policies', err)
      return []
    }
  })

  ipcMain.handle('lifecycle:executeArchivePolicy', async (_, policyId: string) => {
    try {
      const { lifecycleManager } = await import('./lifecycle')
      const result = await lifecycleManager.executeArchivePolicy(policyId)
      return { success: true, ...result }
    } catch (err) {
      logError('Failed to execute archive policy', err)
      return { success: false, error: String(err) }
    }
  })
