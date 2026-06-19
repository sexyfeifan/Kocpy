import type { BackupTask, FileRecord } from './types'

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export function formatDate(ts?: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function formatDuration(startedAt?: number, completedAt?: number): string {
  if (!startedAt || !completedAt) return '-'
  const sec = Math.round((completedAt - startedAt) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m ${sec % 60}s`
}

const CIRCLE_NUMS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']

export function buildDirTree(fileRecords: FileRecord[]): string[] {
  const folderDirect = new Map<string, number>()
  const allFolders = new Set<string>()

  for (const f of fileRecords) {
    const rel = (f.relativePath || f.name).replace(/\\/g, '/')
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      allFolders.add(parts.slice(0, i).join('/'))
    }
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : ''
    folderDirect.set(parent, (folderDirect.get(parent) ?? 0) + f.size)
  }

  if (allFolders.size === 0) return []

  const sorted = Array.from(allFolders).sort()
  const leafSet = new Set(sorted.filter((f) => !sorted.some((g) => g.startsWith(f + '/'))))

  return sorted.map((folder) => {
    const depth = folder.split('/').length - 1
    const name = folder.split('/').pop() ?? folder
    const indent = '  ' + '  '.repeat(depth)
    const nameStr = `${name}/`
    const sizeStr = leafSet.has(folder) ? formatBytes(folderDirect.get(folder) ?? 0) : '—'
    const pad = Math.max(2, 20 - nameStr.length - depth * 2)
    return `${indent}${nameStr}${' '.repeat(pad)}${sizeStr}`
  })
}

export function buildBackupReport(task: BackupTask): string {
  const ok = task.status === 'completed'
  const lines: string[] = []

  lines.push(ok ? '✅ 备份成功  Kocpy' : '❌ 备份失败  Kocpy')
  lines.push('')

  lines.push('📋 任务信息')
  lines.push(`  任务   ${task.name}`)
  lines.push(`  哈希   ${task.hashAlgorithm?.toUpperCase() ?? '-'}`)
  lines.push(`  开始   ${formatDate(task.startedAt)}`)
  lines.push(`  完成   ${formatDate(task.completedAt)}`)
  lines.push(`  耗时   ${formatDuration(task.startedAt, task.completedAt)}`)
  lines.push(`  文件   ${task.totalFiles} 个 · ${formatBytes(task.totalBytes)}`)
  if (task.errorMessage) lines.push(`  错误   ${task.errorMessage}`)

  lines.push('')
  lines.push('📂 路径')
  if (task.sourcePath) lines.push(`  🔵 来源   ${task.sourcePath}`)
  if (task.destinations?.length) {
    task.destinations.forEach((dest, i) => {
      const label = `目标${CIRCLE_NUMS[i] ?? String(i + 1)}`
      const icon = dest.verified ? '🟢' : '🔴'
      const failNote = dest.verified ? '' : '  ← 校验失败'
      lines.push(`  ${icon} ${label}  ${dest.path}${failNote}`)
    })
  }

  lines.push('')
  lines.push('🔍 校验')
  const allVerified = task.destinations?.every((d) => d.verified) ?? false
  const destSize = task.destinations?.reduce((s, d) => s + d.bytesWritten, 0) ?? 0
  if (allVerified) {
    lines.push(`  ✅ 全部通过（src ${formatBytes(task.totalBytes)} = dest ${formatBytes(destSize)}）`)
  } else {
    const failedDests = task.destinations?.filter((d) => !d.verified) ?? []
    lines.push(`  ❌ 部分失败（${failedDests.length} 个目标校验不通过）`)
  }

  const failedFiles = (task.fileRecords ?? []).filter((f) => !f.destinations.every((d) => d.verified))
  if (failedFiles.length > 0) {
    lines.push('')
    lines.push('⚠️ 失败文件')
    for (const f of failedFiles) {
      lines.push(`  ✗ ${f.relativePath || f.name}  (${formatBytes(f.size)})`)
    }
  }

  if (task.fileRecords?.length) {
    const treeLines = buildDirTree(task.fileRecords)
    if (treeLines.length > 0) {
      lines.push('')
      lines.push('📁 目录结构')
      lines.push(...treeLines)
    }
  }

  return lines.join('\n')
}
