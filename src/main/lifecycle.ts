import * as fs from 'fs'
import * as path from 'path'
import { logInfo, logError } from './logger'

/**
 * 媒体生命周期管理模块
 * 素材从拍摄到归档的完整追踪
 */

export type MediaStatus = 
  | 'raw'          // 原始素材
  | 'backedup'     // 已备份
  | 'previewed'    // 已预览
  | 'transcoded'   // 已转码
  | 'editing'      // 编辑中
  | 'graded'       // 已调色
  | 'output'       // 已输出
  | 'archived'     // 已归档
  | 'deleted'      // 已删除

export interface MediaLifecycle {
  id: string
  filePath: string
  fileName: string
  status: MediaStatus
  history: Array<{
    status: MediaStatus
    timestamp: string
    location: string
    notes?: string
  }>
  metadata: {
    size: number
    createdAt: string
    project?: string
    tags?: string[]
  }
  createdAt: string
  updatedAt: string
}

export interface ArchivePolicy {
  id: string
  name: string
  description: string
  conditions: {
    status?: MediaStatus[]
    ageDays?: number
    projectStatus?: 'active' | 'completed' | 'archived'
    storageUsagePercent?: number
  }
  actions: {
    moveTo: 'nas' | 'lto' | 'cloud'
    destination: string
    compress: boolean
    deleteOriginal: boolean
  }
  enabled: boolean
}

/**
 * 媒体生命周期管理器
 */
export class LifecycleManager {
  private lifecycles: Map<string, MediaLifecycle> = new Map()
  private policies: Map<string, ArchivePolicy> = new Map()

  constructor() {
    this.loadLifecycles()
    this.loadPolicies()
  }

  /**
   * 注册媒体文件
   */
  async registerMedia(filePath: string, project?: string, tags?: string[]): Promise<MediaLifecycle> {
    const stat = await fs.promises.stat(filePath)
    const id = this.generateId()

    const lifecycle: MediaLifecycle = {
      id,
      filePath,
      fileName: path.basename(filePath),
      status: 'raw',
      history: [{
        status: 'raw',
        timestamp: new Date().toISOString(),
        location: filePath,
        notes: 'Initial registration'
      }],
      metadata: {
        size: stat.size,
        createdAt: stat.birthtime.toISOString(),
        project,
        tags
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    this.lifecycles.set(id, lifecycle)
    await this.saveLifecycles()

    logInfo(`Media registered: ${filePath} (${id})`)
    return lifecycle
  }

  /**
   * 更新媒体状态
   */
  async updateStatus(id: string, status: MediaStatus, location?: string, notes?: string): Promise<void> {
    const lifecycle = this.lifecycles.get(id)
    if (!lifecycle) {
      throw new Error(`Lifecycle not found: ${id}`)
    }

    lifecycle.status = status
    lifecycle.history.push({
      status,
      timestamp: new Date().toISOString(),
      location: location || lifecycle.filePath,
      notes
    })
    lifecycle.updatedAt = new Date().toISOString()

    this.lifecycles.set(id, lifecycle)
    await this.saveLifecycles()

    logInfo(`Media status updated: ${id} → ${status}`)
  }

  /**
   * 获取媒体生命周期
   */
  getLifecycle(id: string): MediaLifecycle | undefined {
    return this.lifecycles.get(id)
  }

  /**
   * 获取所有媒体生命周期
   */
  getAllLifecycles(): MediaLifecycle[] {
    return Array.from(this.lifecycles.values())
  }

  /**
   * 按状态筛选
   */
  getByStatus(status: MediaStatus): MediaLifecycle[] {
    return Array.from(this.lifecycles.values()).filter(l => l.status === status)
  }

  /**
   * 按项目筛选
   */
  getByProject(project: string): MediaLifecycle[] {
    return Array.from(this.lifecycles.values()).filter(l => l.metadata.project === project)
  }

  /**
   * 搜索媒体
   */
  search(query: string): MediaLifecycle[] {
    const lowerQuery = query.toLowerCase()
    return Array.from(this.lifecycles.values()).filter(l =>
      l.fileName.toLowerCase().includes(lowerQuery) ||
      l.metadata.project?.toLowerCase().includes(lowerQuery) ||
      l.metadata.tags?.some(t => t.toLowerCase().includes(lowerQuery))
    )
  }

  /**
   * 创建归档策略
   */
  async createArchivePolicy(policy: Omit<ArchivePolicy, 'id'>): Promise<ArchivePolicy> {
    const id = this.generateId()
    const newPolicy: ArchivePolicy = { ...policy, id }

    this.policies.set(id, newPolicy)
    await this.savePolicies()

    logInfo(`Archive policy created: ${policy.name} (${id})`)
    return newPolicy
  }

  /**
   * 获取所有归档策略
   */
  getArchivePolicies(): ArchivePolicy[] {
    return Array.from(this.policies.values())
  }

  /**
   * 执行归档策略
   */
  async executeArchivePolicy(policyId: string): Promise<{
    processed: number
    archived: number
    failed: number
    errors: string[]
  }> {
    const policy = this.policies.get(policyId)
    if (!policy || !policy.enabled) {
      throw new Error(`Archive policy not found or disabled: ${policyId}`)
    }

    const result = { processed: 0, archived: 0, failed: 0, errors: [] }

    // 筛选符合条件的媒体
    const candidates = this.filterByPolicy(policy)

    for (const lifecycle of candidates) {
      result.processed++

      try {
        // 执行归档
        await this.archiveMedia(lifecycle, policy)
        result.archived++
      } catch (err) {
        result.failed++
        result.errors.push(`${lifecycle.fileName}: ${err}`)
        logError(`Archive failed for ${lifecycle.fileName}`, err)
      }
    }

    logInfo(`Archive policy executed: ${policy.name} (${result.archived}/${result.processed})`)
    return result
  }

  /**
   * 按策略筛选媒体
   */
  private filterByPolicy(policy: ArchivePolicy): MediaLifecycle[] {
    let candidates = Array.from(this.lifecycles.values())

    // 按状态筛选
    if (policy.conditions.status) {
      candidates = candidates.filter(l => policy.conditions.status!.includes(l.status))
    }

    // 按年龄筛选
    if (policy.conditions.ageDays) {
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - policy.conditions.ageDays)
      candidates = candidates.filter(l => new Date(l.createdAt) < cutoffDate)
    }

    // 按项目状态筛选
    if (policy.conditions.projectStatus) {
      // 这里需要查询项目状态，简化处理
    }

    return candidates
  }

  /**
   * 归档单个媒体
   */
  private async archiveMedia(lifecycle: MediaLifecycle, policy: ArchivePolicy): Promise<void> {
    const destPath = path.join(policy.actions.destination, lifecycle.fileName)

    // 复制文件
    await fs.promises.copyFile(lifecycle.filePath, destPath)

    // 更新状态
    await this.updateStatus(lifecycle.id, 'archived', destPath, `Archived by policy: ${policy.name}`)

    // 删除原文件（如果启用）
    if (policy.actions.deleteOriginal) {
      await fs.promises.unlink(lifecycle.filePath)
    }
  }

  /**
   * 加载生命周期数据
   */
  private async loadLifecycles() {
    try {
      const dataPath = this.getDataPath('lifecycles.json')
      const data = await fs.promises.readFile(dataPath, 'utf-8')
      const lifecycles = JSON.parse(data)
      this.lifecycles = new Map(lifecycles.map((l: MediaLifecycle) => [l.id, l]))
    } catch {
      // 文件不存在或解析失败，使用空数据
    }
  }

  /**
   * 保存生命周期数据
   */
  private async saveLifecycles() {
    const dataPath = this.getDataPath('lifecycles.json')
    const data = JSON.stringify(Array.from(this.lifecycles.values()), null, 2)
    await fs.promises.writeFile(dataPath, data, 'utf-8')
  }

  /**
   * 加载归档策略
   */
  private async loadPolicies() {
    try {
      const dataPath = this.getDataPath('policies.json')
      const data = await fs.promises.readFile(dataPath, 'utf-8')
      const policies = JSON.parse(data)
      this.policies = new Map(policies.map((p: ArchivePolicy) => [p.id, p]))
    } catch {
      // 文件不存在或解析失败，使用空数据
    }
  }

  /**
   * 保存归档策略
   */
  private async savePolicies() {
    const dataPath = this.getDataPath('policies.json')
    const data = JSON.stringify(Array.from(this.policies.values()), null, 2)
    await fs.promises.writeFile(dataPath, data, 'utf-8')
  }

  /**
   * 获取数据文件路径
   */
  private getDataPath(filename: string): string {
    const dataDir = process.env.NODE_ENV === 'development'
      ? path.join(process.cwd(), 'data')
      : path.join(require('electron').app.getPath('userData'), 'data')

    return path.join(dataDir, filename)
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2)
  }

  /**
   * 获取统计信息
   */
  getStatistics(): {
    total: number
    byStatus: Record<MediaStatus, number>
    byProject: Record<string, number>
    totalSize: number
  } {
    const lifecycles = Array.from(this.lifecycles.values())
    const byStatus: Record<MediaStatus, number> = {} as any
    const byProject: Record<string, number> = {}

    let totalSize = 0

    for (const l of lifecycles) {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1
      if (l.metadata.project) {
        byProject[l.metadata.project] = (byProject[l.metadata.project] || 0) + 1
      }
      totalSize += l.metadata.size
    }

    return {
      total: lifecycles.length,
      byStatus,
      byProject,
      totalSize
    }
  }
}

// 导出单例
export const lifecycleManager = new LifecycleManager()
