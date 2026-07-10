import { describe, it, expect } from 'vitest'
import * as path from 'path'

// Re-implement resolveDeviceRoot for testing (same logic as BackupEngine.ts)
function resolveDeviceRoot(
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

describe('resolveDeviceRoot', () => {
  const destPath = '/Volumes/Backup'

  it('handles simple mode (no project folder)', () => {
    const result = resolveDeviceRoot(destPath, '', false, '', 'A机', 'SonyA7IV_202604211435')
    expect(result).toBe('/Volumes/Backup/A机/SonyA7IV_202604211435')
  })

  it('handles simple mode without device', () => {
    const result = resolveDeviceRoot(destPath, '', false, '', '', 'SonyA7IV_202604211435')
    expect(result).toBe('/Volumes/Backup/SonyA7IV_202604211435')
  })

  it('handles project mode with project name', () => {
    const result = resolveDeviceRoot(destPath, '20260420城市探店', true, '20260420', 'A机', 'SonyA7IV_202604211435')
    expect(result).toBe('/Volumes/Backup/20260420城市探店/20260420/A机/SonyA7IV_202604211435')
  })

  it('handles project mode with project name, no device', () => {
    const result = resolveDeviceRoot(destPath, '20260420城市探店', true, '20260420', '', 'SonyA7IV_202604211435')
    expect(result).toBe('/Volumes/Backup/20260420城市探店/20260420/SonyA7IV_202604211435')
  })

  it('handles date-only project (no name)', () => {
    const result = resolveDeviceRoot(destPath, '20260420', false, '20260420', 'B机', 'Untitled_202604201200')
    expect(result).toBe('/Volumes/Backup/20260420/B机/Untitled_202604201200')
  })

  it('handles date-only project without device', () => {
    const result = resolveDeviceRoot(destPath, '20260420', false, '20260420', '', 'Untitled_202604201200')
    expect(result).toBe('/Volumes/Backup/20260420/Untitled_202604201200')
  })
})

describe('incremental backup logic', () => {
  it('detects unchanged file by matching size and mtime', () => {
    const srcStat = { size: 1024, mtimeMs: 1700000000000 }
    const destStat = { size: 1024, mtimeMs: 1700000000000 }
    const unchanged = srcStat.size === destStat.size &&
      Math.floor(srcStat.mtimeMs / 1000) === Math.floor(destStat.mtimeMs / 1000)
    expect(unchanged).toBe(true)
  })

  it('detects changed file by different size', () => {
    const srcStat = { size: 2048, mtimeMs: 1700000000000 }
    const destStat = { size: 1024, mtimeMs: 1700000000000 }
    const unchanged = srcStat.size === destStat.size &&
      Math.floor(srcStat.mtimeMs / 1000) === Math.floor(destStat.mtimeMs / 1000)
    expect(unchanged).toBe(false)
  })

  it('detects changed file by different mtime', () => {
    const srcStat = { size: 1024, mtimeMs: 1700000001000 }
    const destStat = { size: 1024, mtimeMs: 1700000000000 }
    const unchanged = srcStat.size === destStat.size &&
      Math.floor(srcStat.mtimeMs / 1000) === Math.floor(destStat.mtimeMs / 1000)
    expect(unchanged).toBe(false)
  })

  it('treats sub-second mtime differences as unchanged', () => {
    const srcStat = { size: 1024, mtimeMs: 1700000000500 }
    const destStat = { size: 1024, mtimeMs: 1700000000200 }
    const unchanged = srcStat.size === destStat.size &&
      Math.floor(srcStat.mtimeMs / 1000) === Math.floor(destStat.mtimeMs / 1000)
    expect(unchanged).toBe(true)
  })
})
