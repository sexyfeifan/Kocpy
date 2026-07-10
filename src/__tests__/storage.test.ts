import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock fs module
vi.mock('fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
      copyFile: vi.fn(),
    },
    existsSync: vi.fn(),
  },
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    copyFile: vi.fn(),
  },
  existsSync: vi.fn(),
}))

// Mock electron app
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test-user-data'),
  },
}))

import {
  loadSettings,
  saveSettings,
  loadPersistedTasks,
  persistTasks,
  loadProjects,
  saveProjects,
  DEFAULT_SETTINGS,
} from '../main/storage'

describe('Storage Module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('loadSettings', () => {
    it('should return default settings when file does not exist', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('File not found'))

      const settings = await loadSettings()
      expect(settings).toEqual(DEFAULT_SETTINGS)
    })

    it('should merge user settings with defaults', async () => {
      const userSettings = { defaultHash: 'sha256', verifyAfterCopy: false }
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(userSettings))

      const settings = await loadSettings()
      expect(settings.defaultHash).toBe('sha256')
      expect(settings.verifyAfterCopy).toBe(false)
      expect(settings.devices).toEqual(DEFAULT_SETTINGS.devices)
    })
  })

  describe('saveSettings', () => {
    it('should backup existing file before writing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      await saveSettings(DEFAULT_SETTINGS)

      expect(fs.promises.copyFile).toHaveBeenCalled()
      expect(fs.promises.writeFile).toHaveBeenCalled()
      expect(fs.promises.rename).toHaveBeenCalled()
    })

    it('should create atomic write with .tmp file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      await saveSettings(DEFAULT_SETTINGS)

      expect(fs.promises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      )
      expect(fs.promises.rename).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('settings.json')
      )
    })
  })

  describe('loadPersistedTasks', () => {
    it('should return empty array when file does not exist', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('File not found'))

      const tasks = await loadPersistedTasks()
      expect(tasks).toEqual([])
    })

    it('should parse and return tasks', async () => {
      const mockTasks = [{ id: '1', name: 'Test Task' }]
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockTasks))

      const tasks = await loadPersistedTasks()
      expect(tasks).toEqual(mockTasks)
    })
  })

  describe('persistTasks', () => {
    it('should backup and save tasks', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      await persistTasks([{ id: '1', name: 'Test' }] as any)

      expect(fs.promises.copyFile).toHaveBeenCalled()
      expect(fs.promises.writeFile).toHaveBeenCalled()
    })
  })

  describe('loadProjects', () => {
    it('should return empty array when file does not exist', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('File not found'))

      const projects = await loadProjects()
      expect(projects).toEqual([])
    })

    it('should parse and return projects', async () => {
      const mockProjects = [{ id: '1', name: 'Test Project' }]
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(mockProjects))

      const projects = await loadProjects()
      expect(projects).toEqual(mockProjects)
    })
  })

  describe('saveProjects', () => {
    it('should save projects without backup', async () => {
      await saveProjects([{ id: '1', name: 'Test' }] as any)

      expect(fs.promises.writeFile).toHaveBeenCalled()
      expect(fs.promises.copyFile).not.toHaveBeenCalled()
    })
  })
})
