import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// Mock fs module
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    existsSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
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
    it('should return default settings when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('File not found')
      })

      const settings = loadSettings()
      expect(settings).toEqual(DEFAULT_SETTINGS)
    })

    it('should merge user settings with defaults', () => {
      const userSettings = { defaultHash: 'sha256', verifyAfterCopy: false }
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(userSettings))

      const settings = loadSettings()
      expect(settings.defaultHash).toBe('sha256')
      expect(settings.verifyAfterCopy).toBe(false)
      expect(settings.devices).toEqual(DEFAULT_SETTINGS.devices)
    })
  })

  describe('saveSettings', () => {
    it('should backup existing file before writing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      saveSettings(DEFAULT_SETTINGS)

      expect(fs.copyFileSync).toHaveBeenCalled()
      expect(fs.writeFileSync).toHaveBeenCalled()
      expect(fs.renameSync).toHaveBeenCalled()
    })

    it('should create atomic write with .tmp file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      saveSettings(DEFAULT_SETTINGS)

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String),
        'utf-8'
      )
      expect(fs.renameSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('settings.json')
      )
    })
  })

  describe('loadPersistedTasks', () => {
    it('should return empty array when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('File not found')
      })

      const tasks = loadPersistedTasks()
      expect(tasks).toEqual([])
    })

    it('should parse and return tasks', () => {
      const mockTasks = [{ id: '1', name: 'Test Task' }]
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockTasks))

      const tasks = loadPersistedTasks()
      expect(tasks).toEqual(mockTasks)
    })
  })

  describe('persistTasks', () => {
    it('should backup and save tasks', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)

      persistTasks([{ id: '1', name: 'Test' }] as any)

      expect(fs.copyFileSync).toHaveBeenCalled()
      expect(fs.writeFileSync).toHaveBeenCalled()
    })
  })

  describe('loadProjects', () => {
    it('should return empty array when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('File not found')
      })

      const projects = loadProjects()
      expect(projects).toEqual([])
    })

    it('should parse and return projects', () => {
      const mockProjects = [{ id: '1', name: 'Test Project' }]
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockProjects))

      const projects = loadProjects()
      expect(projects).toEqual(mockProjects)
    })
  })

  describe('saveProjects', () => {
    it('should save projects without backup', () => {
      saveProjects([{ id: '1', name: 'Test' }] as any)

      expect(fs.writeFileSync).toHaveBeenCalled()
      expect(fs.copyFileSync).not.toHaveBeenCalled()
    })
  })
})
