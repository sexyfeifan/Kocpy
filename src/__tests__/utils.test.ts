import { describe, it, expect } from 'vitest'

// Re-implement the pure utility functions for testing (same logic as report-builder.ts)
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(0)} KB/s`
  if (bps < 1024 ** 3) return `${(bps / 1024 ** 2).toFixed(1)} MB/s`
  return `${(bps / 1024 ** 3).toFixed(2)} GB/s`
}

function formatEta(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

describe('formatBytes', () => {
  it('returns 0 B for 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes correctly', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB')
    expect(formatBytes(50 * 1024 * 1024 * 1024)).toBe('50 GB')
  })

  it('formats terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB')
  })
})

describe('formatSpeed', () => {
  it('formats B/s', () => {
    expect(formatSpeed(500)).toBe('500 B/s')
  })

  it('formats KB/s', () => {
    expect(formatSpeed(1024)).toBe('1 KB/s')
    expect(formatSpeed(5120)).toBe('5 KB/s')
  })

  it('formats MB/s', () => {
    expect(formatSpeed(1048576)).toBe('1.0 MB/s')
    expect(formatSpeed(10 * 1024 * 1024)).toBe('10.0 MB/s')
  })

  it('formats GB/s', () => {
    expect(formatSpeed(1073741824)).toBe('1.00 GB/s')
  })
})

describe('formatEta', () => {
  it('formats seconds', () => {
    expect(formatEta(30)).toBe('30s')
    expect(formatEta(59)).toBe('59s')
  })

  it('formats minutes and seconds', () => {
    expect(formatEta(60)).toBe('1m 0s')
    expect(formatEta(90)).toBe('1m 30s')
    expect(formatEta(3599)).toBe('59m 59s')
  })

  it('formats hours', () => {
    expect(formatEta(3600)).toBe('1h 0m')
    expect(formatEta(3661)).toBe('1h 1m')
  })
})
