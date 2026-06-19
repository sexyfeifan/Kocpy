import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

type LogLevel = 'INFO' | 'WARN' | 'ERROR'

const LOG_RETENTION_DAYS = 7

let logsDir: string | null = null

/**
 * Initialise the logger. Call once at app startup (after app.whenReady).
 * Creates the logs directory and rotates old log files.
 */
export function initLogger(): void {
  logsDir = path.join(app.getPath('userData'), 'logs')
  try {
    fs.mkdirSync(logsDir, { recursive: true })
  } catch {
    // directory already exists or cannot be created — non-fatal
  }
  rotateOldLogs()
}

/**
 * Return the path to the logs directory (for the "Open Logs Folder" IPC).
 */
export function getLogsDir(): string {
  if (!logsDir) {
    logsDir = path.join(app.getPath('userData'), 'logs')
    try {
      fs.mkdirSync(logsDir, { recursive: true })
    } catch {
      // ignore
    }
  }
  return logsDir
}

// ── Public log helpers ──────────────────────────────────────────────

export function logInfo(message: string): void {
  writeLog('INFO', message)
}

export function logWarn(message: string): void {
  writeLog('WARN', message)
}

export function logError(message: string, error?: unknown): void {
  if (error instanceof Error) {
    writeLog('ERROR', `${message}\n  ${error.message}\n  ${error.stack ?? ''}`)
  } else if (error !== undefined) {
    writeLog('ERROR', `${message}\n  ${String(error)}`)
  } else {
    writeLog('ERROR', message)
  }
}

// ── Internal helpers ────────────────────────────────────────────────

function getLogFilePath(): string {
  const dir = getLogsDir()
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return path.join(dir, `backup_${yyyy}-${mm}-${dd}.log`)
}

function writeLog(level: LogLevel, message: string): void {
  try {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] [${level}] ${message}\n`
    fs.appendFileSync(getLogFilePath(), line, 'utf-8')
  } catch {
    // Logging must never crash the app
  }
}

/**
 * Delete log files older than LOG_RETENTION_DAYS.
 */
function rotateOldLogs(): void {
  const dir = getLogsDir()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }

  const now = Date.now()
  const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000

  for (const entry of entries) {
    // Match backup_YYYY-MM-DD.log
    const match = entry.match(/^backup_(\d{4})-(\d{2})-(\d{2})\.log$/)
    if (!match) continue

    const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    if (now - fileDate.getTime() > maxAge) {
      try {
        fs.unlinkSync(path.join(dir, entry))
      } catch {
        // best-effort deletion
      }
    }
  }
}
