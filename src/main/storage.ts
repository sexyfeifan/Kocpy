import { app } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { logError, logWarn } from './logger'
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

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.promises.readFile(getSettingsPath(), 'utf-8')
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch (err) {
    // Settings file may not exist on first launch, use defaults
    logWarn('Failed to load settings, using defaults: ' + String(err))
    return { ...DEFAULT_SETTINGS }
  }
}

// 【Fix 4】配置备份：写入前备份为 .bak 文件（保留最近1个备份）
export async function backupBeforeWrite(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.copyFile(filePath, filePath + '.bak')
    }
  } catch (e) {
    logError(`Failed to backup ${filePath}`, e)
  }
}

export async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = filePath + '.tmp'
  await fs.promises.writeFile(tmp, data, 'utf-8')
  await fs.promises.rename(tmp, filePath)
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await backupBeforeWrite(getSettingsPath())
  await atomicWrite(getSettingsPath(), JSON.stringify(settings, null, 2))
}

export async function loadPersistedTasks(): Promise<BackupTask[]> {
  try {
    const raw = await fs.promises.readFile(getTasksPath(), 'utf-8')
    return JSON.parse(raw) as BackupTask[]
  } catch (err) {
    // Tasks file may not exist on first launch
    logWarn('Failed to load tasks, returning empty array: ' + String(err))
    return []
  }
}

export async function persistTasks(tasks: BackupTask[]): Promise<void> {
  try {
    await backupBeforeWrite(getTasksPath())
    await atomicWrite(getTasksPath(), JSON.stringify(tasks, null, 2))
  } catch (e) {
    logError('Failed to persist tasks', e)
  }
}

export async function loadProjects(): Promise<ProjectConfig[]> {
  try {
    const raw = await fs.promises.readFile(getProjectsPath(), 'utf-8')
    return JSON.parse(raw) as ProjectConfig[]
  } catch (err) {
    // Projects file may not exist on first launch
    logWarn('Failed to load projects, returning empty array: ' + String(err))
    return []
  }
}

export async function saveProjects(projects: ProjectConfig[]): Promise<void> {
  await atomicWrite(getProjectsPath(), JSON.stringify(projects, null, 2))
}
