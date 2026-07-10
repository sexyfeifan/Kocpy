import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { v4 as uuidv4 } from 'uuid'
import _ffmpegPath from 'ffmpeg-static'
import { logInfo, logWarn, logError } from '../logger'
import { formatBytes, isValidPath, validateTaskName } from '../utils'

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

import type {
  BackupTask,
  FileRecord,
  HashAlgorithm,
  ProgressPayload,
  TaskConfig
} from '../types'

const execFileAsync = promisify(execFile)

// In packaged app, ffmpeg-static resolves inside app.asar (not executable).
// asarUnpack extracts it to app.asar.unpacked, so we remap the path.
const ffmpegPath = _ffmpegPath
  ? _ffmpegPath.replace('app.asar', 'app.asar.unpacked')
  : null

// ── Concurrency pool ────────────────────────────────────────────────────────
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workers: Promise<void>[] = []

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++
      await fn(items[idx], idx)
    }
  }

  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker())
  }
  await Promise.all(workers)
}

export class BackupEngine extends EventEmitter {
  private tasks: Map<string, BackupTask> = new Map()
  private cancelFlags: Map<string, boolean> = new Map()
  // 断点续传：记录每个任务已完成的文件相对路径
  private completedFileSets: Map<string, Set<string>> = new Map()
  // Task queue: pending tasks waiting to run
  private taskQueue: string[] = []
  private runningTaskCount = 0
  private readonly MAX_CONCURRENT_TASKS = 1
  private readonly FILE_CONCURRENCY = 2

  createTask(config: TaskConfig): BackupTask {
    // 验证源路径安全性
    if (!isValidPath(config.sourcePath)) {
      throw new Error('源路径包含不安全的字符或路径')
    }

    // 验证所有目标路径安全性
    for (const destPath of config.destinationPaths) {
      if (!isValidPath(destPath)) {
        throw new Error(`目标路径包含不安全的字符或路径: ${destPath}`)
      }
    }

    // 清理任务名称
    const safeName = validateTaskName(config.namingTemplate || '')

    const now = new Date()
    const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
    const timestamp =
      String(now.getFullYear()) +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      pad(now.getHours()) +
      pad(now.getMinutes())

    // Date folder from shootingDate (YYYY-MM-DD → YYYYMMDD); empty string = no date layer (simple mode)
    const shootingDate = config.shootingDate
      ? config.shootingDate.replace(/-/g, '')
      : ''

    // Top-level project folder: {YYYYMMDD}{projectName} or just {YYYYMMDD}
    const projectFolder = shootingDate
      ? (config.projectName ? `${shootingDate}${config.projectName}` : shootingDate)
      : ''

    const volumeName = safeName
      ? `${safeName}_${timestamp}`
      : `Untitled_${timestamp}`

    const task: BackupTask = {
      id: uuidv4(),
      name: volumeName,
      sourcePath: config.sourcePath,
      devices: config.devices,
      destinations: config.destinationPaths.map((p, i) => ({
        id: uuidv4(),
        path: p,
        label: `备份 ${i + 1}`,
        verified: false,
        bytesWritten: 0
      })),
      hashAlgorithm: config.hashAlgorithm,
      namingTemplate: volumeName,
      shootingDateFolder: projectFolder,
      copyMode: config.copyMode ?? 'normal',
      status: 'pending',
      totalFiles: 0,
      completedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      speedBps: 0,
      eta: 0,
      currentFile: '',
      verifyLog: [],
      fileRecords: [],
      skippedFiles: 0,
      skippedBytes: 0,
      priority: config.priority ?? false,
      duplicateStrategy: config.duplicateStrategy ?? 'skip',
      generateThumbnails: config.generateThumbnails ?? false,
      fx3Rename: config.fx3Rename ?? false,
      includeHidden: config.includeHidden ?? true,
      incremental: config.incremental ?? false,
      unchangedFiles: 0,
      unchangedBytes: 0
    }
    this.tasks.set(task.id, task)
    logInfo(`Task created: ${task.name} (id=${task.id}) source=${config.sourcePath} dests=[${config.destinationPaths.join(', ')}] hash=${config.hashAlgorithm}`)
    return task
  }

  loadTask(task: BackupTask): void {
    this.tasks.set(task.id, task)
  }

  getTask(taskId: string): BackupTask | undefined {
    return this.tasks.get(taskId)
  }

  getAllTasks(): BackupTask[] {
    return Array.from(this.tasks.values())
  }

  cancelTask(taskId: string): void {
    // If queued, remove from queue
    const queueIdx = this.taskQueue.indexOf(taskId)
    if (queueIdx >= 0) {
      this.taskQueue.splice(queueIdx, 1)
      const task = this.tasks.get(taskId)
      if (task) {
        task.status = 'cancelled'
        this.emitProgress(task)
      }
      return
    }
    this.cancelFlags.set(taskId, true)
  }

  deleteTask(taskId: string): void {
    this.tasks.delete(taskId)
    this.cancelFlags.delete(taskId)
    this.completedFileSets.delete(taskId)
    const queueIdx = this.taskQueue.indexOf(taskId)
    if (queueIdx >= 0) this.taskQueue.splice(queueIdx, 1)
  }

  setPriority(taskId: string, priority: boolean): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.priority = priority
      // Re-sort queue by priority
      this.sortQueue()
    }
  }

  // ── Task queue management ─────────────────────────────────────────────────

  private sortQueue(): void {
    this.taskQueue.sort((a, b) => {
      const ta = this.tasks.get(a)
      const tb = this.tasks.get(b)
      const pa = ta?.priority ? 1 : 0
      const pb = tb?.priority ? 1 : 0
      return pb - pa
    })
  }

  private processQueue(): void {
    while (
      this.runningTaskCount < this.MAX_CONCURRENT_TASKS &&
      this.taskQueue.length > 0
    ) {
      const nextId = this.taskQueue.shift()!
      this.runningTaskCount++
      this.runTask(nextId).finally(() => {
        this.runningTaskCount--
        this.processQueue()
      })
    }
  }

  enqueueTask(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)
    task.status = 'pending'
    this.taskQueue.push(taskId)
    this.sortQueue()
    this.emitProgress(task)
    this.processQueue()
  }

  // ── FX3 rename ────────────────────────────────────────────────────────────

  private async runFx3Rename(sourcePath: string, task: BackupTask): Promise<void> {
    const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mxf'])
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(sourcePath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name !== 'Untitled') continue
      const untitledPath = path.join(sourcePath, entry.name)
      let clips: string[]
      try {
        clips = await fs.promises.readdir(untitledPath)
      } catch {
        continue
      }
      const videoFile = clips.find((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()))
      if (!videoFile) continue
      const prefix = path.basename(videoFile, path.extname(videoFile)).slice(0, 4)
      if (!prefix) continue
      let targetName = prefix
      let targetPath = path.join(sourcePath, targetName)
      let suffix = 1
      while (true) {
        try {
          await fs.promises.access(targetPath)
          targetName = `${prefix}_${suffix}`
          targetPath = path.join(sourcePath, targetName)
          suffix++
        } catch {
          break
        }
      }
      try {
        await fs.promises.rename(untitledPath, targetPath)
        task.verifyLog.push(`FX3重命名: Untitled → ${targetName}`)
      } catch (e) {
        task.verifyLog.push(`FX3重命名失败: ${(e as Error).message}`)
      }
    }
  }

  private async runFx3RenameOnDestinations(task: BackupTask): Promise<void> {
    const volumeName = task.namingTemplate
    const projectFolder = task.shootingDateFolder ?? ''
    const hasProjectName = projectFolder.length > 8
    const dateSubFolder = projectFolder.length >= 8 ? projectFolder.slice(0, 8) : ''
    const deviceSubfolders = task.devices.length > 0 ? task.devices : ['']

    for (const dest of task.destinations) {
      if (task.copyMode === 'mirror') {
        await this.runFx3Rename(dest.path, task)
      } else {
        for (const device of deviceSubfolders) {
          const deviceRoot = this.resolveDeviceRoot(dest.path, projectFolder, hasProjectName, dateSubFolder, device, volumeName)
          await this.runFx3Rename(deviceRoot, task)
        }
      }
    }
  }

  // ── Main task execution ───────────────────────────────────────────────────

  /**
   * Queue a task for execution (respects priority ordering).
   * Call enqueueTask() instead of startTask() for managed execution.
   */
  startTask(taskId: string, options?: { verifyAfterCopy?: boolean }): void {
    this.enqueueTask(taskId)
  }

  private async runTask(taskId: string, options?: { verifyAfterCopy?: boolean }): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)

    this.cancelFlags.set(taskId, false)
    task.status = 'running'
    task.startedAt = Date.now()
    task.verifyLog = []
    task.unchangedFiles = 0
    task.unchangedBytes = 0
    logInfo(`Task started: ${task.name} (id=${task.id}) source=${task.sourcePath} files=${task.totalFiles} bytes=${task.totalBytes}`)

    // 初始化断点续传的已完成文件集合
    if (!this.completedFileSets.has(taskId)) {
      this.completedFileSets.set(taskId, new Set<string>())
    }
    const completedSet = this.completedFileSets.get(taskId)!

    const volumeName = task.namingTemplate

    try {
      const { files, emptyDirs } = await this.enumerateFiles(task.sourcePath, undefined, task, task.includeHidden ?? true)
      task.totalFiles = files.length
      task.totalBytes = files.reduce((sum, f) => sum + f.size, 0)
      this.emitProgress(task)

      // 磁盘空间预检
      for (const dest of task.destinations) {
        try {
          const stat = await fs.promises.statfs(dest.path)
          const freeBytes = stat.bfree * stat.bsize
          if (freeBytes < task.totalBytes) {
            const freeStr = formatBytes(freeBytes)
            const needStr = formatBytes(task.totalBytes)
            throw new Error(
              `目标磁盘空间不足: ${dest.path}（可用 ${freeStr}，需要 ${needStr}）。请释放空间后重试。`
            )
          }
        } catch (err) {
          if ((err as Error).message.startsWith('目标磁盘空间不足')) throw err
          task.verifyLog.push(`⚠ 无法检查 ${dest.path} 的可用空间，跳过预检`)
        }
      }
      this.emitProgress(task)

      if (task.copyMode === 'mirror') {
        for (const dest of task.destinations) {
          await fs.promises.mkdir(dest.path, { recursive: true })
          for (const emptyDir of emptyDirs) {
            await fs.promises.mkdir(path.join(dest.path, emptyDir), { recursive: true })
          }
          dest.resolvedPath = dest.path
        }
      } else {
        const projectFolder = task.shootingDateFolder ?? ''
        const hasProjectName = projectFolder.length > 8
        const dateSubFolder = projectFolder.length >= 8 ? projectFolder.slice(0, 8) : ''

        for (const dest of task.destinations) {
          const deviceSubfolders = task.devices.length > 0 ? task.devices : ['']
          for (const device of deviceSubfolders) {
            const deviceRoot = this.resolveDeviceRoot(dest.path, projectFolder, hasProjectName, dateSubFolder, device, volumeName)
            await fs.promises.mkdir(deviceRoot, { recursive: true })
            for (const emptyDir of emptyDirs) {
              await fs.promises.mkdir(path.join(deviceRoot, emptyDir), { recursive: true })
            }
          }
          dest.resolvedPath = projectFolder ? path.join(dest.path, projectFolder) : dest.path
        }
      }

      let speedSamples: number[] = []
      let lastBytes = 0
      let lastTime = Date.now()

      // Concurrent file copy with pool size = FILE_CONCURRENCY
      await runWithConcurrency(files, this.FILE_CONCURRENCY, async (file) => {
        if (this.cancelFlags.get(taskId)) return

        // 断点续传：跳过已复制完成的文件
        if (completedSet.has(file.relativePath)) {
          task.completedFiles++
          task.transferredBytes += file.size
          return
        }

        task.currentFile = file.name
        this.emitProgress(task)

        const record = await this.copyFileToAllDestinationsParallel(
          task,
          file,
          (bytesWritten) => {
            task.transferredBytes += bytesWritten
            const now = Date.now()
            const elapsed = (now - lastTime) / 1000
            if (elapsed >= 0.5) {
              const currentSpeed = (task.transferredBytes - lastBytes) / elapsed
              speedSamples.push(currentSpeed)
              if (speedSamples.length > 5) speedSamples.shift()
              task.speedBps = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length
              lastBytes = task.transferredBytes
              lastTime = now
              const remaining = task.totalBytes - task.transferredBytes
              task.eta = task.speedBps > 0 ? remaining / task.speedBps : 0
              this.emitProgress(task)
            }
          }
        )

        task.fileRecords.push(record)
        task.completedFiles++
        completedSet.add(file.relativePath)
        this.emitProgress(task)
      })

      if (options?.verifyAfterCopy !== false) {
        task.status = 'verifying'
        this.emitProgress(task)
        await this.verifyAllDestinations(task)
      }

      task.status = 'completed'
      task.completedAt = Date.now()
      const duration = Math.round((task.completedAt - task.startedAt!) / 1000)
      logInfo(`Task completed: ${task.name} (id=${task.id}) files=${task.completedFiles} unchanged=${task.unchangedFiles} duration=${duration}s`)
      task.currentFile = ''
      task.speedBps = 0
      task.eta = 0
      this.completedFileSets.delete(taskId)
      this.cancelFlags.delete(taskId)
      this.emitProgress(task)

      if (task.generateThumbnails) {
        await this.generateThumbnails(task)
        this.emitProgress(task)
      }

      if (task.fx3Rename) {
        await this.runFx3RenameOnDestinations(task)
      }
    } catch (err) {
      task.status = 'failed'
      task.errorMessage = (err as Error).message
      logError(`Task failed: ${task.name} (id=${task.id})`, err)
      this.completedFileSets.delete(taskId)
      this.cancelFlags.delete(taskId)
      this.emitProgress(task)
      throw err
    }
  }

  // ── Path resolution ───────────────────────────────────────────────────────

  private resolveDeviceRoot(
    destPath: string,
    projectFolder: string,
    hasProjectName: boolean,
    dateSubFolder: string,
    device: string,
    volumeName: string
  ): string {
    if (projectFolder && hasProjectName) {
      return device
        ? path.join(destPath, projectFolder, dateSubFolder, device, volumeName)
        : path.join(destPath, projectFolder, dateSubFolder, volumeName)
    } else if (projectFolder) {
      return device
        ? path.join(destPath, projectFolder, device, volumeName)
        : path.join(destPath, projectFolder, volumeName)
    } else {
      return device
        ? path.join(destPath, device, volumeName)
        : path.join(destPath, volumeName)
    }
  }

  // ── Incremental backup: check if destination file is unchanged ────────────

  private async isFileUnchanged(srcPath: string, destPath: string): Promise<boolean> {
    try {
      const [srcStat, destStat] = await Promise.all([
        fs.promises.stat(srcPath),
        fs.promises.stat(destPath)
      ])
      return srcStat.size === destStat.size &&
        Math.floor(srcStat.mtimeMs / 1000) === Math.floor(destStat.mtimeMs / 1000)
    } catch {
      return false
    }
  }

  // ── Copy to all destinations ──────────────────────────────────────────────

  private async copyFileToAllDestinationsParallel(
    task: BackupTask,
    file: { name: string; relativePath: string; size: number; absolutePath: string },
    onProgress: (bytes: number) => void
  ): Promise<FileRecord> {
    const projectFolder = task.shootingDateFolder ?? ''
    const hasProjectName = projectFolder.length > 8
    const dateSubFolder = projectFolder.length >= 8 ? projectFolder.slice(0, 8) : ''
    const volumeName = task.namingTemplate
    const deviceSubfolders = task.devices.length > 0 ? task.devices : ['']

    // Deferred pattern: subsequent destinations await this instead of busy-waiting
    let srcChecksum: string | null = null
    let resolveSrcChecksum: (checksum: string) => void
    let rejectSrcChecksum: (err: Error) => void
    const srcChecksumReady = new Promise<string>((resolve, reject) => {
      resolveSrcChecksum = resolve
      rejectSrcChecksum = reject
    })

    const destResults = await Promise.all(
      task.destinations.map(async (dest, destIdx) => {
        let destFilePath: string
        if (task.copyMode === 'mirror') {
          destFilePath = path.join(dest.path, file.relativePath)
        } else {
          const device = deviceSubfolders[0]
          const deviceRoot = this.resolveDeviceRoot(dest.path, projectFolder, hasProjectName, dateSubFolder, device, volumeName)
          destFilePath = path.join(deviceRoot, file.relativePath)
        }

        try {
          await fs.promises.mkdir(path.dirname(destFilePath), { recursive: true })

          // Incremental: skip unchanged files (same size + mtime)
          if (task.incremental) {
            const unchanged = await this.isFileUnchanged(file.absolutePath, destFilePath)
            if (unchanged) {
              task.unchangedFiles = (task.unchangedFiles ?? 0) + 1
              task.unchangedBytes = (task.unchangedBytes ?? 0) + file.size
              return { path: destFilePath, checksum: '', verified: true, unchanged: true }
            }
          }

          // Duplicate file handling strategy
          const fileExists = await fs.promises.access(destFilePath).then(() => true).catch(() => false)
          if (fileExists) {
            if (task.duplicateStrategy === 'skip') {
              return { path: destFilePath, checksum: '', verified: true, skipped: true }
            } else {
              const ext = path.extname(destFilePath)
              const stem = destFilePath.slice(0, destFilePath.length - ext.length)
              let n = 1
              let candidate = `${stem}_copy_${n}${ext}`
              while (await fs.promises.access(candidate).then(() => true).catch(() => false)) {
                n++
                candidate = `${stem}_copy_${n}${ext}`
              }
              destFilePath = candidate
            }
          }

          if (destIdx === 0) {
            let computedSrcChecksum: string
            try {
              const result = await this.copyFileAndHash(
                file.absolutePath,
                destFilePath,
                task.hashAlgorithm,
                (bytes) => {
                  dest.bytesWritten += bytes
                  onProgress(bytes / task.destinations.length)
                },
                task.id
              )
              computedSrcChecksum = result.checksum
              srcChecksum = computedSrcChecksum
              resolveSrcChecksum(computedSrcChecksum)
            } catch (err) {
              rejectSrcChecksum(err as Error)
              throw err
            }

            const destChecksum = await this.hashFile(destFilePath, task.hashAlgorithm)
            const verified = destChecksum === computedSrcChecksum
            if (!verified) {
              dest.error = `校验失败: ${file.relativePath}`
            }
            return { path: destFilePath, checksum: destChecksum, verified }
          } else {
            const srcHash = await srcChecksumReady

            await this.copyFile(
              file.absolutePath,
              destFilePath,
              (bytes) => {
                dest.bytesWritten += bytes
                onProgress(bytes / task.destinations.length)
              },
              task.id
            )

            const destChecksum = await this.hashFile(destFilePath, task.hashAlgorithm)
            const verified = destChecksum === srcHash
            if (!verified) {
              dest.error = `校验失败: ${file.relativePath}`
            }
            return { path: destFilePath, checksum: destChecksum, verified }
          }
        } catch (err) {
          // P1: Independent destination error handling — mark this dest failed, don't propagate
          const msg = (err as Error).message
          logError(`File copy failed: ${file.relativePath} → ${dest.path}`, err)
          fs.promises.unlink(destFilePath + '.tmp').catch(() => {})
          dest.error = `拷贝失败: ${file.relativePath} — ${msg}`
          dest.verified = false
          return { path: destFilePath, checksum: '', verified: false, error: msg }
        }
      })
    )

    const finalSrcChecksum = srcChecksum ?? ''

    return {
      name: file.name,
      relativePath: file.relativePath,
      size: file.size,
      srcChecksum: finalSrcChecksum,
      destinations: destResults
    }
  }

  // ── File copy with hash (first destination) ───────────────────────────────

  private copyFileAndHash(
    src: string,
    dest: string,
    algorithm: HashAlgorithm,
    onProgress: (bytes: number) => void,
    taskId?: string
  ): Promise<{ checksum: string }> {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

      const hash = crypto.createHash(algorithm)
      const readStream = fs.createReadStream(src, { highWaterMark: 2 * 1024 * 1024 })
      const tmpPath = dest + '.tmp'
      const writeStream = fs.createWriteStream(tmpPath)

      readStream.on('data', (chunk: Buffer | string) => {
        if (taskId && this.cancelFlags.get(taskId)) {
          readStream.destroy()
          writeStream.destroy()
          return
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(buf)
        onProgress(buf.length)
      })

      readStream.on('error', (err) => {
        writeStream.destroy()
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      writeStream.on('error', (err) => {
        readStream.destroy()
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      writeStream.on('finish', () => settle(() => {
        fs.promises.rename(tmpPath, dest)
          .then(() => resolve({ checksum: hash.digest('hex') }))
          .catch((renameErr) => { fs.promises.unlink(tmpPath).catch(() => {}); reject(renameErr) })
      }))
      readStream.on('close', () => {
        if (taskId && this.cancelFlags.get(taskId)) {
          settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); resolve({ checksum: hash.digest('hex') }) })
        }
      })

      readStream.pipe(writeStream)
    })
  }

  // ── File copy without hash (subsequent destinations) ──────────────────────

  private copyFile(
    src: string,
    dest: string,
    onProgress: (bytes: number) => void,
    taskId?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }

      const readStream = fs.createReadStream(src, { highWaterMark: 2 * 1024 * 1024 })
      const tmpPath = dest + '.tmp'
      const writeStream = fs.createWriteStream(tmpPath)

      readStream.on('data', (chunk: Buffer | string) => {
        if (taskId && this.cancelFlags.get(taskId)) {
          readStream.destroy()
          writeStream.destroy()
          return
        }
        onProgress(Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk))
      })

      readStream.on('error', (err) => {
        writeStream.destroy()
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      writeStream.on('error', (err) => {
        readStream.destroy()
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      writeStream.on('finish', () => settle(() => {
        fs.promises.rename(tmpPath, dest)
          .then(() => resolve())
          .catch((renameErr) => { fs.promises.unlink(tmpPath).catch(() => {}); reject(renameErr) })
      }))
      readStream.on('close', () => {
        if (taskId && this.cancelFlags.get(taskId)) settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); resolve() })
      })

      readStream.pipe(writeStream)
    })
  }

  // ── Hash file ─────────────────────────────────────────────────────────────

  private hashFile(filePath: string, algorithm: HashAlgorithm): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm)
      const stream = fs.createReadStream(filePath, { highWaterMark: 2 * 1024 * 1024 })
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }

  // ── P0: Verification — re-read and re-hash destination files ──────────────

  private async verifyAllDestinations(task: BackupTask): Promise<void> {
    task.verifyLog = []
    task.verifyCompletedFiles = 0
    // Only verify files that were actually copied (not unchanged/incremental skips)
    const filesToVerify = task.fileRecords.filter(r => !r.skipped)
    task.verifyTotalFiles = filesToVerify.length * task.destinations.length
    logInfo(`Verification started: ${task.name} (${task.verifyTotalFiles} checks)`)

    for (let dIdx = 0; dIdx < task.destinations.length; dIdx++) {
      const dest = task.destinations[dIdx]
      let allVerified = true

      for (const record of filesToVerify) {
        if (this.cancelFlags.get(task.id)) break

        const destEntry = record.destinations[dIdx]

        if (!destEntry) {
          allVerified = false
          task.verifyLog.push(`✗ ${record.name} 目标记录缺失`)
          if (task.verifyLog.length > 100) task.verifyLog.shift()
          task.verifyCompletedFiles++
          this.emitProgress(task)
          continue
        }

        // Skip verification for unchanged (incremental) files
        if (destEntry.unchanged) {
          task.verifyLog.push(`⊙ ${record.name} [${dest.path.split('/').pop() || dest.path}] (未变更，跳过校验)`)
          if (task.verifyLog.length > 100) task.verifyLog.shift()
          task.verifyCompletedFiles++
          this.emitProgress(task)
          continue
        }

        // P0: Re-read and re-hash the destination file to catch post-write corruption
        let verified = false
        try {
          const destChecksum = await this.hashFile(destEntry.path, task.hashAlgorithm)
          verified = destChecksum === record.srcChecksum
          destEntry.verified = verified
        } catch (err) {
          verified = false
          destEntry.verified = false
          task.verifyLog.push(`✗ ${record.name} [${dest.path.split('/').pop() || dest.path}] 读取失败: ${(err as Error).message}`)
        }

        if (!verified) {
          allVerified = false
          task.verifyLog.push(`✗ ${record.name} [${dest.path.split('/').pop() || dest.path}]`)
        } else {
          task.verifyLog.push(`✓ ${record.name} [${dest.path.split('/').pop() || dest.path}]`)
        }
        if (task.verifyLog.length > 100) task.verifyLog.shift()
        task.verifyCompletedFiles++
        this.emitProgress(task)
      }

      dest.verified = allVerified
      logInfo(`Verification ${allVerified ? 'PASSED' : 'FAILED'} for dest: ${dest.path}`)
    }
  }

  // ── File enumeration ──────────────────────────────────────────────────────

  private async enumerateFiles(
    dirPath: string,
    baseDir?: string,
    task?: BackupTask,
    includeHidden?: boolean
  ): Promise<{
    files: Array<{ name: string; relativePath: string; size: number; absolutePath: string }>
    emptyDirs: string[]
  }> {
    const base = baseDir ?? dirPath
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const files: Array<{
      name: string
      relativePath: string
      size: number
      absolutePath: string
    }> = []
    const emptyDirs: string[] = []

    let hasNonHiddenContent = false

    for (const entry of entries) {
      if (entry.name.startsWith('.') && !includeHidden) {
        if (task) {
          if (entry.isFile()) {
            const hiddenStat = await fs.promises.stat(path.join(dirPath, entry.name)).catch(() => null)
            if (hiddenStat) {
              task.skippedFiles = (task.skippedFiles ?? 0) + 1
              task.skippedBytes = (task.skippedBytes ?? 0) + hiddenStat.size
            }
          } else {
            task.skippedFiles = (task.skippedFiles ?? 0) + 1
          }
        }
        continue
      }
      hasNonHiddenContent = true
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const nested = await this.enumerateFiles(fullPath, base, task, includeHidden)
        files.push(...nested.files)
        emptyDirs.push(...nested.emptyDirs)
        if (nested.files.length === 0 && nested.emptyDirs.length === 0) {
          emptyDirs.push(path.relative(base, fullPath))
        }
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(fullPath)
        files.push({
          name: entry.name,
          relativePath: path.relative(base, fullPath),
          size: stat.size,
          absolutePath: fullPath
        })
      }
    }

    if (!hasNonHiddenContent && baseDir !== undefined && !includeHidden) {
      emptyDirs.push(path.relative(base, dirPath))
    }

    return { files, emptyDirs }
  }

  // ── Progress emission ─────────────────────────────────────────────────────

  private emitProgress(task: BackupTask): void {
    const payload: ProgressPayload = {
      taskId: task.id,
      status: task.status,
      totalFiles: task.totalFiles,
      completedFiles: task.completedFiles,
      totalBytes: task.totalBytes,
      transferredBytes: task.transferredBytes,
      speedBps: task.speedBps,
      eta: task.eta,
      currentFile: task.currentFile,
      verifyLog: [...task.verifyLog],
      destinations: task.destinations,
      errorMessage: task.errorMessage,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      verifyCompletedFiles: task.verifyCompletedFiles,
      verifyTotalFiles: task.verifyTotalFiles,
      skippedFiles: task.skippedFiles,
      skippedBytes: task.skippedBytes,
      unchangedFiles: task.unchangedFiles,
      unchangedBytes: task.unchangedBytes
    }
    this.emit('progress', payload)
  }

  // ── Resume set ────────────────────────────────────────────────────────────

  async initResumeSet(taskId: string): Promise<number> {
    const task = this.tasks.get(taskId)
    if (!task) return 0

    const completedSet = new Set<string>()

    for (const dest of task.destinations) {
      if (!dest.resolvedPath) continue
      try {
        const files = task.fileRecords ?? []
        for (const record of files) {
          completedSet.add(record.relativePath)
        }
      } catch {
        // ignore
      }
    }

    this.completedFileSets.set(taskId, completedSet)
    return completedSet.size
  }

  // ── Thumbnail generation ──────────────────────────────────────────────────

  private async generateThumbnails(task: BackupTask): Promise<void> {
    if (!ffmpegPath) {
      task.thumbnailError = 'ffmpeg 未找到，无法生成缩略图。请联系开发者或重新安装应用。'
      return
    }

    const ffmpegWorks = await execFileAsync(ffmpegPath!, ['-version'])
      .then(() => true)
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EACCES') {
          task.thumbnailError = 'ffmpeg 没有执行权限。请前往「系统偏好设置 → 安全性与隐私」允许运行，或重新安装应用。'
        } else if (err.code === 'ENOENT') {
          task.thumbnailError = '找不到 ffmpeg，请重新安装 Kocpy。'
        } else {
          task.thumbnailError = `ffmpeg 无法运行（${err.message ?? err.code}），请重新安装应用。`
        }
        return false
      })

    if (!ffmpegWorks) return

    const videoExts = new Set(['.mxf', '.mov', '.mp4', '.r3d', '.ari', '.braw'])
    let generated = 0
    let failed = 0

    for (const record of task.fileRecords) {
      const ext = path.extname(record.name).toLowerCase()
      if (!videoExts.has(ext)) continue
      for (const destEntry of record.destinations) {
        if (!destEntry.verified || !destEntry.path) continue
        const stem = destEntry.path.slice(0, destEntry.path.length - path.extname(destEntry.path).length)
        const thumbPath = `${stem}_thumb.jpg`
        const ok = await execFileAsync(ffmpegPath!, ['-y', '-i', destEntry.path, '-vframes', '1', '-q:v', '2', thumbPath])
          .then(() => true).catch(() => false)
        if (ok && !record.thumbnailPath) {
          record.thumbnailPath = thumbPath
          generated++
        } else if (!ok) {
          failed++
        }
        break
      }
    }

    if (generated === 0 && failed > 0) {
      task.thumbnailError = `共 ${failed} 个视频文件缩略图生成失败，可能是文件格式不受支持或文件损坏。`
    }
  }
}
