import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { v4 as uuidv4 } from 'uuid'
import _ffmpegPath from 'ffmpeg-static'
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

export class BackupEngine extends EventEmitter {
  private tasks: Map<string, BackupTask> = new Map()
  private cancelFlags: Map<string, boolean> = new Map()
  // 断点续传：记录每个任务已完成的文件相对路径
  private completedFileSets: Map<string, Set<string>> = new Map()

  createTask(config: TaskConfig): BackupTask {
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

    const volumeName = config.namingTemplate
      ? `${config.namingTemplate}_${timestamp}`
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
      fx3Rename: config.fx3Rename ?? false
    }
    this.tasks.set(task.id, task)
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
    this.cancelFlags.set(taskId, true)
  }

  deleteTask(taskId: string): void {
    this.tasks.delete(taskId)
    this.cancelFlags.delete(taskId)
  }

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

  // P0-1: 备份完成后，在每个目的地的副本上执行 FX3 重命名（不在源盘操作）
  private async runFx3RenameOnDestinations(task: BackupTask): Promise<void> {
    const volumeName = task.namingTemplate
    const projectFolder = task.shootingDateFolder ?? ''
    const hasProjectName = projectFolder.length > 8
    const dateSubFolder = projectFolder.length >= 8 ? projectFolder.slice(0, 8) : ''
    const deviceSubfolders = task.devices.length > 0 ? task.devices : ['']

    for (const dest of task.destinations) {
      if (task.copyMode === 'mirror') {
        // mirror 模式：直接在 dest.path 下扫描 Untitled 目录
        await this.runFx3Rename(dest.path, task)
      } else {
        // normal 模式：在每个 deviceRoot 下扫描 Untitled 目录
        for (const device of deviceSubfolders) {
          const deviceRoot = this.resolveDeviceRoot(dest.path, projectFolder, hasProjectName, dateSubFolder, device, volumeName)
          await this.runFx3Rename(deviceRoot, task)
        }
      }
    }
  }

  async startTask(taskId: string, options?: { verifyAfterCopy?: boolean }): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`Task ${taskId} not found`)

    this.cancelFlags.set(taskId, false)
    task.status = 'running'
    task.startedAt = Date.now()
    task.verifyLog = []

    // 初始化断点续传的已完成文件集合
    if (!this.completedFileSets.has(taskId)) {
      this.completedFileSets.set(taskId, new Set<string>())
    }
    const completedSet = this.completedFileSets.get(taskId)!

    // P0-1: 不在源盘执行 FX3 重命名（已移到备份完成后在目标端执行）

    const volumeName = task.namingTemplate

    try {
      const { files, emptyDirs } = await this.enumerateFiles(task.sourcePath, undefined, task)
      task.totalFiles = files.length
      task.totalBytes = files.reduce((sum, f) => sum + f.size, 0)
      this.emitProgress(task)

      // 【Fix 1】磁盘空间预检：检查每个目的地的可用空间是否足够
      for (const dest of task.destinations) {
        try {
          const stat = await (fs.promises as any).statfs(dest.path)
          const freeBytes = stat.bfree * stat.bsize
          if (freeBytes < task.totalBytes) {
            const freeStr = this.formatBytes(freeBytes)
            const needStr = this.formatBytes(task.totalBytes)
            throw new Error(
              `目标磁盘空间不足: ${dest.path}（可用 ${freeStr}，需要 ${needStr}）。请释放空间后重试。`
            )
          }
        } catch (err) {
          // 如果是磁盘空间不足的错误，直接抛出
          if ((err as Error).message.startsWith('目标磁盘空间不足')) throw err
          // statfs 不支持时忽略（例如网络路径）
          task.verifyLog.push(`⚠ 无法检查 ${dest.path} 的可用空间，跳过预检`)
        }
      }
      this.emitProgress(task)

      if (task.copyMode === 'mirror') {
        // Mirror mode: dest is an exact A=B copy — no folder wrapping, preserve relative paths
        for (const dest of task.destinations) {
          await fs.promises.mkdir(dest.path, { recursive: true })
          // Create empty directories in mirror mode
          for (const emptyDir of emptyDirs) {
            await fs.promises.mkdir(path.join(dest.path, emptyDir), { recursive: true })
          }
          dest.resolvedPath = dest.path
        }
      } else {
        // #B fix: distinguish "has project name" (length > 8) from "date-only" (exactly 8 digits)
        const projectFolder = task.shootingDateFolder ?? ''
        const hasProjectName = projectFolder.length > 8
        const dateSubFolder = projectFolder.length >= 8 ? projectFolder.slice(0, 8) : ''

        for (const dest of task.destinations) {
          const deviceSubfolders = task.devices.length > 0 ? task.devices : ['']
          for (const device of deviceSubfolders) {
            const deviceRoot = this.resolveDeviceRoot(dest.path, projectFolder, hasProjectName, dateSubFolder, device, volumeName)
            await fs.promises.mkdir(deviceRoot, { recursive: true })
            // Create empty directories under device root
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

      for (const file of files) {
        if (this.cancelFlags.get(taskId)) {
          task.status = 'cancelled'
          this.emitProgress(task)
          return
        }

        // 【Fix 2】断点续传：跳过已复制完成的文件
        if (completedSet.has(file.relativePath)) {
          task.completedFiles++
          task.transferredBytes += file.size
          continue
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
        // 【Fix 2】记录已复制完成的文件
        completedSet.add(file.relativePath)
        this.emitProgress(task)
      }

      if (options?.verifyAfterCopy !== false) {
        task.status = 'verifying'
        this.emitProgress(task)
        await this.verifyAllDestinations(task)
      }

      task.status = 'completed'
      task.completedAt = Date.now()
      task.currentFile = ''
      task.speedBps = 0
      task.eta = 0
      this.emitProgress(task)

      if (task.generateThumbnails) {
        await this.generateThumbnails(task)
        this.emitProgress(task)
      }

      // P0-1: 备份完成后，在每个目的地执行 FX3 重命名（不在源盘操作）
      if (task.fx3Rename) {
        await this.runFx3RenameOnDestinations(task)
      }
    } catch (err) {
      task.status = 'failed'
      task.errorMessage = (err as Error).message
      this.emitProgress(task)
      throw err
    }
  }

  // #B fix: single source of truth for device root path resolution
  private resolveDeviceRoot(
    destPath: string,
    projectFolder: string,
    hasProjectName: boolean,
    dateSubFolder: string,
    device: string,
    volumeName: string
  ): string {
    if (projectFolder && hasProjectName) {
      // advanced + project name: dest/{YYYYMMDD}{name}/{YYYYMMDD}/{device}/{vol}
      return device
        ? path.join(destPath, projectFolder, dateSubFolder, device, volumeName)
        : path.join(destPath, projectFolder, dateSubFolder, volumeName)
    } else if (projectFolder) {
      // advanced + date only: dest/{YYYYMMDD}/{device}/{vol}
      return device
        ? path.join(destPath, projectFolder, device, volumeName)
        : path.join(destPath, projectFolder, volumeName)
    } else {
      // simple mode: dest/{device}/{vol}
      return device
        ? path.join(destPath, device, volumeName)
        : path.join(destPath, volumeName)
    }
  }

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
            // First destination: compute src hash during the copy stream
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

            // Verify destination
            const destChecksum = await this.hashFile(destFilePath, task.hashAlgorithm)
            const verified = destChecksum === computedSrcChecksum
            if (!verified) {
              dest.error = `校验失败: ${file.relativePath}`
            }
            return { path: destFilePath, checksum: destChecksum, verified }
          } else {
            // Subsequent destinations: await the shared Promise (no busy-wait)
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
          // Mark this destination as failed, don't propagate to Promise.all
          const msg = (err as Error).message
          // P0-4: 写入失败时清理可能残留的 .tmp 文件
          fs.promises.unlink(destFilePath + '.tmp').catch(() => {})
          dest.error = `拷贝失败: ${file.relativePath} — ${msg}`
          dest.verified = false
          return { path: destFilePath, checksum: '', verified: false, error: msg }
        }
      })
    )

    // srcChecksum may still be null if the first destination failed entirely
    const finalSrcChecksum = srcChecksum ?? ''

    return {
      name: file.name,
      relativePath: file.relativePath,
      size: file.size,
      srcChecksum: finalSrcChecksum,
      destinations: destResults
    }
  }

  // Bug 3 fix: computes src hash during copy stream — one read pass instead of two
  // Bug fix: single resolution guarantee — only finish OR close resolves, never both
  // P0-2: 先写入 .tmp 临时文件，完成后原子性 rename 到最终路径
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
      // P0-2: 写入临时文件 dest + '.tmp'
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
        // P0-2: 写入失败时清理 .tmp 文件
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      writeStream.on('error', (err) => {
        readStream.destroy()
        // P0-2: 写入失败时清理 .tmp 文件
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      // P0-2: 写入完成后原子性重命名到最终路径
      writeStream.on('finish', () => settle(() => {
        fs.promises.rename(tmpPath, dest)
          .then(() => resolve({ checksum: hash.digest('hex') }))
          .catch((renameErr) => { fs.promises.unlink(tmpPath).catch(() => {}); reject(renameErr) })
      }))
      readStream.on('close', () => {
        if (taskId && this.cancelFlags.get(taskId)) {
          // P0-2: 取消时清理 .tmp 文件
          settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); resolve({ checksum: hash.digest('hex') }) })
        }
      })

      readStream.pipe(writeStream)
    })
  }

  // #5 fix: accepts taskId to check cancel flag and destroy streams on cancel
  // Bug fix: single resolution guarantee
  // P0-2: 先写入 .tmp 临时文件，完成后原子性 rename 到最终路径
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
      // P0-2: 写入临时文件 dest + '.tmp'
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
        // P0-2: 写入失败时清理 .tmp 文件
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      writeStream.on('error', (err) => {
        readStream.destroy()
        // P0-2: 写入失败时清理 .tmp 文件
        settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); reject(err) })
      })
      // P0-2: 写入完成后原子性重命名到最终路径
      writeStream.on('finish', () => settle(() => {
        fs.promises.rename(tmpPath, dest)
          .then(() => resolve())
          .catch((renameErr) => { fs.promises.unlink(tmpPath).catch(() => {}); reject(renameErr) })
      }))
      readStream.on('close', () => {
        // P0-2: 取消时清理 .tmp 文件
        if (taskId && this.cancelFlags.get(taskId)) settle(() => { fs.promises.unlink(tmpPath).catch(() => {}); resolve() })
      })

      readStream.pipe(writeStream)
    })
  }

  private hashFile(filePath: string, algorithm: HashAlgorithm): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm)
      const stream = fs.createReadStream(filePath, { highWaterMark: 2 * 1024 * 1024 })
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }

  // #8 + #3 fix: use cached checksums from fileRecords (no third hash pass) and write verified back
  private async verifyAllDestinations(task: BackupTask): Promise<void> {
    task.verifyLog = []
    task.verifyCompletedFiles = 0
    task.verifyTotalFiles = task.fileRecords.length * task.destinations.length

    for (let dIdx = 0; dIdx < task.destinations.length; dIdx++) {
      const dest = task.destinations[dIdx]
      let allVerified = true

      for (let rIdx = 0; rIdx < task.fileRecords.length; rIdx++) {
        if (this.cancelFlags.get(task.id)) break

        const record = task.fileRecords[rIdx]
        const destEntry = record.destinations[dIdx]

        if (!destEntry) {
          allVerified = false
          task.verifyLog.push(`✗ ${record.name} 目标记录缺失`)
          if (task.verifyLog.length > 100) task.verifyLog.shift()
          task.verifyCompletedFiles++
          this.emitProgress(task)
          continue
        }

        // Use cached copy-time checksum — no re-hashing needed
        const verified = destEntry.checksum === record.srcChecksum
        destEntry.verified = verified

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
    }
  }

  // Bug 4 fix: also returns empty directories so they can be created at destinations
  private async enumerateFiles(
    dirPath: string,
    baseDir?: string,
    task?: BackupTask
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
      if (entry.name.startsWith('.')) {
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
        const nested = await this.enumerateFiles(fullPath, base, task)
        files.push(...nested.files)
        emptyDirs.push(...nested.emptyDirs)
        // If nested returned no files and no emptyDirs of its own, this sub-dir is empty
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

    // If the directory itself is empty (or only had hidden entries), record it
    // but only if it's not the root (baseDir is set, meaning we're in a subdirectory)
    if (!hasNonHiddenContent && baseDir !== undefined) {
      emptyDirs.push(path.relative(base, dirPath))
    }

    return { files, emptyDirs }
  }

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
      skippedBytes: task.skippedBytes
    }
    this.emit('progress', payload)
  }

  // 格式化字节数为人类可读字符串
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  // 断点续传：恢复已完成文件集合（重启后从目的地已存在文件推断）
  async initResumeSet(taskId: string): Promise<number> {
    const task = this.tasks.get(taskId)
    if (!task) return 0

    const completedSet = new Set<string>()

    // 遍历每个目的地，检查哪些源文件已经存在于目的地
    for (const dest of task.destinations) {
      if (!dest.resolvedPath) continue
      try {
        const files = task.fileRecords ?? []
        for (const record of files) {
          // 从 fileRecords 中恢复已完成的文件
          completedSet.add(record.relativePath)
        }
      } catch {
        // 忽略不可访问的目的地
      }
    }

    this.completedFileSets.set(taskId, completedSet)
    return completedSet.size
  }

  private async generateThumbnails(task: BackupTask): Promise<void> {
    if (!ffmpegPath) {
      task.thumbnailError = 'ffmpeg 未找到，无法生成缩略图。请联系开发者或重新安装应用。'
      return
    }

    // Verify the binary is actually executable before processing all files
    // P0-3: 使用 execFile 避免命令注入（文件名中的特殊字符不会被 shell 解释）
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
        // P0-3: 使用 execFile 避免命令注入
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
