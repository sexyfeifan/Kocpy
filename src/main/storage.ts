import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import type { BackupTask, ProjectConfig } from './types'

export interface AppSettings {
  defaultHash: 'md5' | 'sha1' | 'sha256'
  verifyAfterCopy: boolean
  devices: string[]
  defaultDuplicateStrategy?: 'skip' | 'suffix'
  defaultGenerateThumbnails?: boolean
  webhookUrl?: string
  webhookEnabled?: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultHash: 'md5',
  verifyAfterCopy: true,
  devices: ['A机', 'B机', 'C机', 'DIT']
}

export function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getTasksPath(): string {
  return join(app.getPath('userData'), 'tasks.json')
}

export function getProjectsPath(): string {
  return join(app.getPath('userData'), 'projects.json')
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf-8')
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

// 【Fix 4】配置备份：写入前备份为 .bak 文件（保留最近1个备份）
export function backupBeforeWrite(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak')
    }
  } catch (e) {
    console.error(`Failed to backup ${filePath}:`, e)
  }
}

export function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function saveSettings(settings: AppSettings): void {
  backupBeforeWrite(getSettingsPath())
  atomicWrite(getSettingsPath(), JSON.stringify(settings, null, 2))
}

export function loadPersistedTasks(): BackupTask[] {
  try {
    const raw = fs.readFileSync(getTasksPath(), 'utf-8')
    return JSON.parse(raw) as BackupTask[]
  } catch {
    return []
  }
}

export function persistTasks(tasks: BackupTask[]): void {
  try {
    backupBeforeWrite(getTasksPath())
    atomicWrite(getTasksPath(), JSON.stringify(tasks, null, 2))
  } catch (e) {
    console.error('Failed to persist tasks:', e)
  }
}

export function loadProjects(): ProjectConfig[] {
  try {
    const raw = fs.readFileSync(getProjectsPath(), 'utf-8')
    return JSON.parse(raw) as ProjectConfig[]
  } catch {
    return []
  }
}

export function saveProjects(projects: ProjectConfig[]): void {
  atomicWrite(getProjectsPath(), JSON.stringify(projects, null, 2))
}
