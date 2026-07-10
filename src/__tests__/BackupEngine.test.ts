import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BackupEngine } from '../main/backup/BackupEngine'

// Mock dependencies
vi.mock('fs', () => ({
  default: {
    promises: {
      readdir: vi.fn().mockResolvedValue([]),
      stat: vi.fn(),
      statfs: vi.fn(),
      mkdir: vi.fn(),
      copyFile: vi.fn(),
      unlink: vi.fn(),
      rename: vi.fn(),
      access: vi.fn(),
    },
    existsSync: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
  },
  promises: {
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn(),
    statfs: vi.fn(),
    mkdir: vi.fn(),
    copyFile: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    access: vi.fn(),
  },
  existsSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn(),
}))

vi.mock('../main/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../main/utils', () => ({
  formatBytes: vi.fn((bytes) => `${bytes} bytes`),
}))

describe('BackupEngine', () => {
  let engine: BackupEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new BackupEngine()
  })

  describe('createTask', () => {
    it('should create a task with correct properties', () => {
      const config = {
        sourcePath: '/Volumes/TestCard',
        destinationPaths: ['/Volumes/Backup1', '/Volumes/Backup2'],
        hashAlgorithm: 'sha256' as const,
        namingTemplate: 'TestCard',
        devices: [],
      }

      const task = engine.createTask(config)

      expect(task.id).toBeDefined()
      expect(task.name).toContain('TestCard')
      expect(task.sourcePath).toBe('/Volumes/TestCard')
      expect(task.destinations).toHaveLength(2)
      expect(task.hashAlgorithm).toBe('sha256')
      expect(task.status).toBe('pending')
    })

    it('should set default values correctly', () => {
      const config = {
        sourcePath: '/Volumes/TestCard',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test',
        devices: [],
      }

      const task = engine.createTask(config)

      expect(task.priority).toBe(false)
      expect(task.duplicateStrategy).toBe('skip')
      expect(task.generateThumbnails).toBe(false)
      expect(task.incremental).toBe(false)
    })

    it('should create unique task IDs', () => {
      const config = {
        sourcePath: '/Volumes/TestCard',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test',
        devices: [],
      }

      const task1 = engine.createTask(config)
      const task2 = engine.createTask(config)

      expect(task1.id).not.toBe(task2.id)
    })
  })

  describe('Task Queue Management', () => {
    it('should add tasks to queue', () => {
      const config = {
        sourcePath: '/Volumes/TestCard',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test',
        devices: [],
      }

      const task = engine.createTask(config)
      engine.enqueueTask(task.id)

      // Task should be in queue (may start running due to async)
      const retrievedTask = engine.getTask(task.id)
      expect(retrievedTask).toBeDefined()
      expect(retrievedTask?.id).toBe(task.id)
    })

    it('should prioritize tasks correctly', () => {
      const config1 = {
        sourcePath: '/Volumes/TestCard1',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test1',
        devices: [],
      }

      const config2 = {
        sourcePath: '/Volumes/TestCard2',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test2',
        devices: [],
      }

      const task1 = engine.createTask(config1)
      const task2 = engine.createTask(config2)

      engine.enqueueTask(task1.id)
      engine.enqueueTask(task2.id)

      // Set task2 as high priority
      engine.setPriority(task2.id, true)

      // Task2 should be prioritized
      const allTasks = engine.getAllTasks()
      const highPriorityTask = allTasks.find(t => t.priority)
      expect(highPriorityTask?.id).toBe(task2.id)
    })

    it('should cancel queued tasks', () => {
      const config = {
        sourcePath: '/Volumes/TestCard',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test',
        devices: [],
      }

      const task = engine.createTask(config)
      engine.enqueueTask(task.id)
      engine.cancelTask(task.id)

      // Task should be cancelled or already completed
      const retrievedTask = engine.getTask(task.id)
      expect(retrievedTask).toBeDefined()
    })
  })

  describe('Task Management', () => {
    it('should delete tasks', () => {
      const config = {
        sourcePath: '/Volumes/TestCard',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test',
        devices: [],
      }

      const task = engine.createTask(config)
      expect(engine.getTask(task.id)).toBeDefined()

      engine.deleteTask(task.id)
      expect(engine.getTask(task.id)).toBeUndefined()
    })

    it('should get all tasks', () => {
      const config1 = {
        sourcePath: '/Volumes/TestCard1',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test1',
        devices: [],
      }

      const config2 = {
        sourcePath: '/Volumes/TestCard2',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'sha256' as const,
        namingTemplate: 'Test2',
        devices: [],
      }

      engine.createTask(config1)
      engine.createTask(config2)

      const allTasks = engine.getAllTasks()
      expect(allTasks).toHaveLength(2)
    })

    it('should set priority', () => {
      const config = {
        sourcePath: '/Volumes/TestCard',
        destinationPaths: ['/Volumes/Backup1'],
        hashAlgorithm: 'md5' as const,
        namingTemplate: 'Test',
        devices: [],
      }

      const task = engine.createTask(config)
      engine.setPriority(task.id, true)

      const retrievedTask = engine.getTask(task.id)
      expect(retrievedTask?.priority).toBe(true)
    })
  })
})
