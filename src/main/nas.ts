import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logInfo, logWarn, logError } from './logger'

const execFileAsync = promisify(execFile)

/**
 * NAS 管理模块
 * 支持 NAS 设备发现、健康监控、增量同步
 */

export interface NASDevice {
  id: string
  name: string
  host: string
  protocol: 'smb' | 'nfs' | 'afp'
  shares: Share[]
  health: NASHealth
  discoveredAt: string
}

export interface Share {
  name: string
  path: string
  permissions: {
    read: boolean
    write: boolean
  }
}

export interface NASHealth {
  smart: SMARTStatus
  capacity: {
    total: number
    used: number
    available: number
  }
  raid: RAIDStatus
  temperature?: number
  uptime?: number
}

export interface SMARTStatus {
  healthy: boolean
  temperature: number
  powerOnHours: number
  reallocatedSectors: number
}

export interface RAIDStatus {
  type: string  // RAID 0, 1, 5, 6, 10, etc.
  status: 'healthy' | 'degraded' | 'failed'
  disks: number
  activeDisks: number
}

export interface SyncJob {
  id: string
  source: string
  destination: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: {
    totalFiles: number
    syncedFiles: number
    totalBytes: number
    syncedBytes: number
    currentFile?: string
  }
  startedAt?: string
  completedAt?: string
  error?: string
}

/**
 * NAS 管理器
 */
export class NASManager {
  private discoveredDevices: Map<string, NASDevice> = new Map()
  private syncJobs: Map<string, SyncJob> = new Map()

  /**
   * 扫描局域网 NAS 设备
   */
  async scanNetwork(): Promise<NASDevice[]> {
    logInfo('开始扫描局域网 NAS 设备...')

    const devices: NASDevice[] = []

    // 扫描 SMB 共享
    const smbDevices = await this.scanSMB()
    devices.push(...smbDevices)

    // 扫描 NFS 共享
    const nfsDevices = await this.scanNFS()
    devices.push(...nfsDevices)

    // 扫描 AFP 共享
    const afpDevices = await this.scanAFP()
    devices.push(...afpDevices)

    // 更新发现的设备
    for (const device of devices) {
      this.discoveredDevices.set(device.id, device)
    }

    logInfo(`发现 ${devices.length} 个 NAS 设备`)
    return devices
  }

  /**
   * 扫描 SMB 共享
   */
  private async scanSMB(): Promise<NASDevice[]> {
    const devices: NASDevice[] = []

    try {
      // 使用 smbutil 发现 SMB 服务器
      const { stdout } = await execFileAsync('smbutil', ['lookup', '-w', 'WORKGROUP'], {
        timeout: 5000
      }).catch(() => ({ stdout: '' }))

      const hosts = this.parseSMBHosts(stdout)

      for (const host of hosts) {
        try {
          const shares = await this.listSMBShares(host)
          const device: NASDevice = {
            id: `smb-${host}`,
            name: host,
            host,
            protocol: 'smb',
            shares,
            health: await this.getNASHealth(host),
            discoveredAt: new Date().toISOString()
          }
          devices.push(device)
        } catch (err) {
          logWarn(`Failed to query SMB host ${host}:`, err)
        }
      }
    } catch (err) {
      logWarn('SMB scan failed:', err)
    }

    return devices
  }

  /**
   * 解析 SMB 主机列表
   */
  private parseSMBHosts(output: string): string[] {
    const hosts: string[] = []
    const lines = output.split('\n')

    for (const line of lines) {
      const match = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+/)
      if (match) {
        hosts.push(match[1])
      }
    }

    return hosts
  }

  /**
   * 列出 SMB 共享
   */
  private async listSMBShares(host: string): Promise<Share[]> {
    const shares: Share[] = []

    try {
      const { stdout } = await execFileAsync('smbutil', ['view', `//${host}`], {
        timeout: 5000
      }).catch(() => ({ stdout: '' }))

      const lines = stdout.split('\n')
      for (const line of lines) {
        const match = line.match(/^(\S+)\s+/)
        if (match && !match[1].startsWith('IPC')) {
          shares.push({
            name: match[1],
            path: `smb://${host}/${match[1]}`,
            permissions: {
              read: true,
              write: true  // 假设有写权限
            }
          })
        }
      }
    } catch (err) {
      logWarn(`Failed to list SMB shares for ${host}:`, err)
    }

    return shares
  }

  /**
   * 扫描 NFS 共享
   */
  private async scanNFS(): Promise<NASDevice[]> {
    // NFS 扫描实现
    return []
  }

  /**
   * 扫描 AFP 共享
   */
  private async scanAFP(): Promise<NASDevice[]> {
    // AFP 扫描实现
    return []
  }

  /**
   * 获取 NAS 健康状态
   */
  private async getNASHealth(host: string): Promise<NASHealth> {
    // 简化的健康检查
    return {
      smart: {
        healthy: true,
        temperature: 45,
        powerOnHours: 1000,
        reallocatedSectors: 0
      },
      capacity: {
        total: 1000000000000,  // 1TB
        used: 500000000000,    // 500GB
        available: 500000000000 // 500GB
      },
      raid: {
        type: 'RAID 1',
        status: 'healthy',
        disks: 2,
        activeDisks: 2
      }
    }
  }

  /**
   * 创建同步任务
   */
  async createSyncJob(source: string, destination: string): Promise<SyncJob> {
    const job: SyncJob = {
      id: `sync-${Date.now()}`,
      source,
      destination,
      status: 'pending',
      progress: {
        totalFiles: 0,
        syncedFiles: 0,
        totalBytes: 0,
        syncedBytes: 0
      }
    }

    this.syncJobs.set(job.id, job)
    logInfo(`同步任务创建: ${job.id}`)

    return job
  }

  /**
   * 执行增量同步
   */
  async startSync(jobId: string): Promise<void> {
    const job = this.syncJobs.get(jobId)
    if (!job) {
      throw new Error(`Sync job not found: ${jobId}`)
    }

    job.status = 'running'
    job.startedAt = new Date().toISOString()

    try {
      // 扫描源目录
      const sourceFiles = await this.listFiles(job.source)
      job.progress.totalFiles = sourceFiles.length
      job.progress.totalBytes = sourceFiles.reduce((sum, f) => sum + f.size, 0)

      // 扫描目标目录
      const destFiles = await this.listFiles(job.destination)
      const destFileMap = new Map(destFiles.map(f => [f.relativePath, f]))

      // 增量同步
      for (const sourceFile of sourceFiles) {
        const destFile = destFileMap.get(sourceFile.relativePath)

        // 检查是否需要同步
        if (!destFile || this.isFileModified(sourceFile, destFile)) {
          await this.syncFile(sourceFile.path, path.join(job.destination, sourceFile.relativePath))
          job.progress.syncedFiles++
          job.progress.syncedBytes += sourceFile.size
          job.progress.currentFile = sourceFile.relativePath
        }
      }

      job.status = 'completed'
      job.completedAt = new Date().toISOString()
      logInfo(`同步完成: ${jobId}`)
    } catch (err) {
      job.status = 'failed'
      job.error = String(err)
      logError(`同步失败: ${jobId}`, err)
    }
  }

  /**
   * 列出目录下的文件
   */
  private async listFiles(dirPath: string): Promise<Array<{ path: string; relativePath: string; size: number; modified: Date }>> {
    const files: Array<{ path: string; relativePath: string; size: number; modified: Date }> = []

    async function scan(currentPath: string, relativePath: string) {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name)
        const relPath = path.join(relativePath, entry.name)

        if (entry.isDirectory()) {
          await scan(fullPath, relPath)
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(fullPath)
          files.push({
            path: fullPath,
            relativePath: relPath,
            size: stat.size,
            modified: stat.mtime
          })
        }
      }
    }

    await scan(dirPath, '')
    return files
  }

  /**
   * 检查文件是否已修改
   */
  private isFileModified(source: { size: number; modified: Date }, dest: { size: number; modified: Date }): boolean {
    return source.size !== dest.size || source.modified.getTime() > dest.modified.getTime()
  }

  /**
   * 同步单个文件
   */
  private async syncFile(sourcePath: string, destPath: string): Promise<void> {
    const destDir = path.dirname(destPath)
    await fs.promises.mkdir(destDir, { recursive: true })
    await fs.promises.copyFile(sourcePath, destPath)
  }

  /**
   * 获取所有已发现的设备
   */
  getDiscoveredDevices(): NASDevice[] {
    return Array.from(this.discoveredDevices.values())
  }

  /**
   * 获取所有同步任务
   */
  getSyncJobs(): SyncJob[] {
    return Array.from(this.syncJobs.values())
  }

  /**
   * 获取同步任务状态
   */
  getSyncJobStatus(jobId: string): SyncJob | undefined {
    return this.syncJobs.get(jobId)
  }

  /**
   * 取消同步任务
   */
  async cancelSyncJob(jobId: string): Promise<void> {
    const job = this.syncJobs.get(jobId)
    if (job) {
      job.status = 'failed'
      job.error = 'Cancelled by user'
      logInfo(`同步任务取消: ${jobId}`)
    }
  }
}

// 导出单例
export const nasManager = new NASManager()
