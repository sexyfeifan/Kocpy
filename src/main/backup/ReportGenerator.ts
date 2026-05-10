import * as fs from 'fs'
import type { BackupTask } from '../types'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function generateReport(task: BackupTask, options: { includeThumbnails?: boolean } = {}): Promise<Buffer> {
  const statusLabel =
    task.status === 'completed' ? '备份成功' :
    task.status === 'failed' ? '备份失败' : '部分完成'
  const statusColor =
    task.status === 'completed' ? '#22c55e' :
    task.status === 'failed' ? '#ef4444' : '#f59e0b'

  const duration =
    task.startedAt && task.completedAt
      ? formatDuration(task.completedAt - task.startedAt)
      : '-'

  const destRows = task.destinations.map((d) => `
    <tr>
      <td>${esc(d.path)}</td>
      <td>${formatBytes(d.bytesWritten)}</td>
      <td style="color:${d.verified ? '#22c55e' : d.error ? '#ef4444' : '#888'}">
        ${d.verified ? '✓ 通过' : d.error ? `✗ ${esc(d.error)}` : '未知'}
      </td>
    </tr>`).join('')

  const fileRows = (await Promise.all(task.fileRecords.map(async (f) => {
    const allOk = f.destinations.every((d) => d.verified)
    let thumbCell = ''
    if (options.includeThumbnails && f.thumbnailPath) {
      try {
        const b64 = fs.readFileSync(f.thumbnailPath).toString('base64')
        thumbCell = `<td style="padding:4px 10px"><img src="data:image/jpeg;base64,${b64}" style="height:48px;width:auto;border-radius:4px;display:block" /></td>`
      } catch {
        thumbCell = '<td></td>'
      }
    } else if (options.includeThumbnails) {
      thumbCell = '<td></td>'
    }
    return `
    <tr>
      <td>${esc(f.relativePath)}</td>
      <td>${formatBytes(f.size)}</td>
      <td class="mono">${esc(f.srcChecksum)}</td>
      <td style="color:${allOk ? '#22c55e' : '#ef4444'}">${allOk ? '✓ 全部通过' : '✗ 校验失败'}</td>
      ${thumbCell}
    </tr>`
  }))).join('')

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kocpy 备份报告 — ${esc(task.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    font-size: 13px;
    color: #1a1a1a;
    background: #f5f5f5;
    padding: 32px;
  }
  .header {
    background: #0f0f0f;
    color: #fff;
    padding: 24px 28px;
    border-radius: 12px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 24px;
  }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .header p { font-size: 11px; color: #888; margin-top: 4px; }
  .badge {
    padding: 6px 14px;
    border-radius: 6px;
    font-weight: 600;
    font-size: 12px;
    color: #fff;
    background: ${statusColor};
    white-space: nowrap;
    margin-top: 4px;
  }
  .section { background: #fff; border-radius: 10px; padding: 20px 24px; margin-bottom: 16px; }
  .section h2 {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #888;
    border-bottom: 1px solid #eee;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }
  .info-grid { display: grid; grid-template-columns: 140px 1fr; row-gap: 8px; }
  .info-grid .label { color: #888; }
  .info-grid .value { color: #1a1a1a; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    background: #1a1a1a;
    color: #fff;
    padding: 8px 10px;
    text-align: left;
    font-weight: 600;
  }
  td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; word-break: break-all; }
  tr:nth-child(even) td { background: #fafafa; }
  .mono { font-family: "SF Mono", "Menlo", monospace; }
  .footer { text-align: center; font-size: 11px; color: #aaa; margin-top: 24px; }
  @media print {
    body { background: #fff; padding: 0; }
    .section { box-shadow: none; }
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>Kocpy</h1>
    <p>专业素材备份报告</p>
    <p style="margin-top:8px;font-size:12px;color:#aaa">生成时间：${new Date().toLocaleString('zh-CN')}</p>
  </div>
  <div class="badge">${statusLabel}</div>
</div>

<div class="section">
  <h2>任务信息</h2>
  <div class="info-grid">
    <span class="label">任务名称</span><span class="value">${esc(task.name)}</span>
    <span class="label">源路径</span><span class="value">${esc(task.sourcePath)}</span>
    <span class="label">机位</span><span class="value">${esc((task.devices || []).join(' / ') || '-')}</span>
    <span class="label">哈希算法</span><span class="value">${task.hashAlgorithm.toUpperCase()}</span>
    <span class="label">总文件数</span><span class="value">${task.totalFiles} 个</span>
    <span class="label">总数据量</span><span class="value">${formatBytes(task.totalBytes)}</span>
    <span class="label">开始时间</span><span class="value">${task.startedAt ? new Date(task.startedAt).toLocaleString('zh-CN') : '-'}</span>
    <span class="label">完成时间</span><span class="value">${task.completedAt ? new Date(task.completedAt).toLocaleString('zh-CN') : '-'}</span>
    <span class="label">耗时</span><span class="value">${duration}</span>
  </div>
</div>

<div class="section">
  <h2>备份目的地</h2>
  <table>
    <thead><tr><th>目的地路径</th><th>写入数据</th><th>校验状态</th></tr></thead>
    <tbody>${destRows}</tbody>
  </table>
</div>

<div class="section">
  <h2>文件清单</h2>
  <table>
    <thead><tr><th>文件路径</th><th>大小</th><th>源校验值</th><th>校验结果</th>${options.includeThumbnails ? '<th>首帧缩略图</th>' : ''}</tr></thead>
    <tbody>${fileRows}</tbody>
  </table>
</div>

<div class="footer">Kocpy 专业素材备份 · 共 ${task.totalFiles} 个文件 · ${formatBytes(task.totalBytes)}</div>

</body>
</html>`

  return Buffer.from(html, 'utf-8')
}
