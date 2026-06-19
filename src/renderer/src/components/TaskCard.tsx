import { CheckCircle2, XCircle, Clock, Loader2, FileDown, StopCircle, Trash2, Zap, HardDrive, AlertTriangle } from 'lucide-react'
import type { BackupTask } from '../types'
import { useTaskStore } from '../store/taskStore'
import { useState } from 'react'
import { formatBytes, formatEta, formatDuration, formatTime } from '../utils'

const STATUS_CONFIG = {
  pending:   { color: 'text-gray-400', bg: 'bg-gray-400', label: '等待中', Icon: Clock },
  running:   { color: 'text-blue-400', bg: 'bg-blue-500', label: '拷贝中', Icon: Loader2 },
  verifying: { color: 'text-amber-400', bg: 'bg-amber-400', label: '校验中', Icon: Loader2 },
  completed: { color: 'text-green-400', bg: 'bg-green-500', label: '已完成', Icon: CheckCircle2 },
  failed:    { color: 'text-red-400',  bg: 'bg-red-500',   label: '失败',   Icon: XCircle },
  cancelled: { color: 'text-gray-500', bg: 'bg-gray-500',  label: '已取消', Icon: XCircle }
}

interface Props { task: BackupTask }

export function TaskCard({ task }: Props): JSX.Element {
  const { deleteTask, setPriority } = useTaskStore()
  const cfg = STATUS_CONFIG[task.status]
  const Icon = cfg.Icon
  const progress = task.totalBytes > 0 ? (task.transferredBytes / task.totalBytes) * 100 : 0
  const isActive = task.status === 'running' || task.status === 'verifying'
  const isDone = !isActive

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [showExportOptions, setShowExportOptions] = useState(false)
  const [includeThumbnails, setIncludeThumbnails] = useState(false)

  const verifyTotal = task.verifyTotalFiles ?? 0
  const verifyDone = task.verifyCompletedFiles ?? 0
  const verifyProgress = verifyTotal > 0 ? (verifyDone / verifyTotal) * 100 : 0

  const handleCancel = () => window.api.cancelTask(task.id)

  const handleExport = async () => {
    if (task.generateThumbnails && task.status === 'completed' && !showExportOptions) {
      setShowExportOptions(true)
      return
    }
    const savePath = await window.api.saveReport(task.name)
    if (savePath) {
      await window.api.generateReport(task.id, savePath, { includeThumbnails })
      setShowExportOptions(false)
      window.api.revealInFinder(savePath)
    }
  }

  const handleDelete = () => deleteTask(task.id)

  const recentVerifyLog = task.verifyLog ? task.verifyLog.slice(-3) : []

  return (
    <div className="glass-card p-4 animate-slide-in">
      {/* Top row */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`flex items-center gap-1.5 text-xs font-medium ${cfg.color}`}>
              <Icon size={12} className={isActive ? 'animate-spin' : ''} />
              {cfg.label}
            </span>
            <span className="text-gray-600 text-xs">·</span>
            <span className="text-gray-500 text-xs font-mono">{task.hashAlgorithm.toUpperCase()}</span>
            {task.priority && (
              <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs bg-amber-500/15 text-amber-400 border border-amber-500/25">
                <Zap size={9} />
                优先
              </span>
            )}
          </div>
          <h3 className="text-sm font-semibold text-gray-100 truncate">{task.name}</h3>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/25 shrink-0">
              <HardDrive size={9} />
              数据来源
            </span>
            <p className="text-xs text-gray-500 truncate">{task.sourcePath}</p>
          </div>
          {task.destinations.map((dest) => (
            <div key={dest.id} className="flex items-center gap-1.5 mt-1">
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/25 shrink-0">
                <HardDrive size={9} />
                备份路径
              </span>
              <p className="text-xs text-gray-500 truncate">{dest.path}</p>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 ml-3 shrink-0">
          {task.status === 'pending' && (
            <button
              onClick={() => setPriority(task.id, !task.priority)}
              className={`p-1.5 rounded-lg transition-colors ${
                task.priority
                  ? 'text-amber-400 bg-amber-400/10 hover:bg-amber-400/20'
                  : 'text-gray-500 hover:text-amber-400 hover:bg-amber-400/10'
              }`}
              title={task.priority ? '取消优先' : '设为优先执行'}
            >
              <Zap size={15} />
            </button>
          )}
          {isActive && (
            confirmCancel ? (
              <>
                <span className="text-xs text-red-400 mr-1">确认取消?</span>
                <button
                  onClick={handleCancel}
                  className="px-2 py-1 rounded-lg text-xs text-red-400 bg-red-400/10 hover:bg-red-400/20 transition-colors"
                >
                  确认
                </button>
                <button
                  onClick={() => setConfirmCancel(false)}
                  className="px-2 py-1 rounded-lg text-xs text-gray-500 hover:bg-white/5 transition-colors"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmCancel(true)}
                className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                title="取消任务"
              >
                <StopCircle size={15} />
              </button>
            )
          )}
          {(task.status === 'completed' || task.status === 'failed') && (
            <button
              onClick={handleExport}
              className="p-1.5 rounded-lg text-gray-500 hover:text-blue-400 hover:bg-blue-400/10 transition-colors"
              title="导出备份报告"
            >
              <FileDown size={15} />
            </button>
          )}
          {isDone && (
            confirmDelete ? (
              <>
                <span className="text-xs text-red-400 mr-1">确认删除?</span>
                <button
                  onClick={handleDelete}
                  className="px-2 py-1 rounded-lg text-xs text-red-400 bg-red-400/10 hover:bg-red-400/20 transition-colors"
                >
                  确认
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1 rounded-lg text-xs text-gray-500 hover:bg-white/5 transition-colors"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                title="删除任务记录"
              >
                <Trash2 size={15} />
              </button>
            )
          )}
        </div>
      </div>

      {/* Thumbnail export options panel */}
      {showExportOptions && (
        <div className="mb-3 px-3 py-2.5 bg-blue-500/10 border border-blue-500/25 rounded-lg flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeThumbnails}
              onChange={(e) => setIncludeThumbnails(e.target.checked)}
              className="rounded accent-blue-500"
            />
            <span className="text-xs text-blue-300">在报告中包含首帧缩略图</span>
          </label>
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={async () => {
                const savePath = await window.api.saveReport(task.name)
                if (savePath) {
                  await window.api.generateReport(task.id, savePath, { includeThumbnails })
                  setShowExportOptions(false)
                  window.api.revealInFinder(savePath)
                }
              }}
              className="px-2.5 py-1 rounded-lg text-xs text-blue-400 bg-blue-400/10 hover:bg-blue-400/20 transition-colors"
            >
              导出
            </button>
            <button
              onClick={() => setShowExportOptions(false)}
              className="px-2.5 py-1 rounded-lg text-xs text-gray-500 hover:bg-white/5 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Completion banner */}
      {task.status === 'completed' && (
        <div className="mb-3 px-3 py-2.5 bg-green-500/10 border border-green-500/25 rounded-lg flex items-center gap-2">
          <CheckCircle2 size={14} className="text-green-400 shrink-0" />
          <span className="text-xs font-medium text-green-400">
            备份完成 — 全部 {task.totalFiles} 个文件已校验通过
            {(task.skippedFiles ?? 0) > 0 && (
              <span className="text-green-500/70 font-normal ml-1">
                （跳过 {task.skippedFiles} 个系统隐藏文件，共 {formatBytes(task.skippedBytes ?? 0)}）
              </span>
            )}
          </span>
        </div>
      )}

      {/* Thumbnail generation error */}
      {task.status === 'completed' && task.generateThumbnails && task.thumbnailError && (
        <div className="mb-3 px-3 py-2.5 bg-amber-500/10 border border-amber-500/25 rounded-lg flex items-start gap-2">
          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-medium text-amber-400 mb-0.5">缩略图生成失败</p>
            <p className="text-xs text-amber-400/70">{task.thumbnailError}</p>
          </div>
        </div>
      )}
      {task.status === 'failed' && (
        <div className="mb-3 px-3 py-2.5 bg-red-500/10 border border-red-500/25 rounded-lg flex items-center gap-2">
          <XCircle size={14} className="text-red-400 shrink-0" />
          <span className="text-xs font-medium text-red-400">备份失败</span>
        </div>
      )}
      {task.status === 'cancelled' && (
        <div className="mb-3 px-3 py-2.5 bg-gray-500/10 border border-gray-500/25 rounded-lg flex items-center gap-2">
          <XCircle size={14} className="text-gray-500 shrink-0" />
          <span className="text-xs font-medium text-gray-500">任务已取消</span>
        </div>
      )}

      {/* Copy progress bar */}
      {(task.status === 'running' || task.status === 'completed') && (
        <div className="mb-3">
          <div className="progress-bar h-1.5 mb-1.5">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                task.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
              }`}
              style={{ width: task.status === 'completed' ? '100%' : `${progress}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>
              {task.status === 'completed'
                ? `${task.totalFiles} 个文件`
                : task.currentFile ? task.currentFile : '准备中...'}
            </span>
            <span>
              {task.status === 'completed'
                ? formatBytes(task.totalBytes)
                : `${formatBytes(task.transferredBytes)} / ${formatBytes(task.totalBytes)}`}
            </span>
          </div>
        </div>
      )}

      {/* Verify progress bar */}
      {task.status === 'verifying' && (
        <div className="mb-3">
          <div className="progress-bar h-1.5 mb-1.5">
            <div
              className="h-full rounded-full transition-all duration-300 bg-amber-400"
              style={{ width: verifyTotal > 0 ? `${verifyProgress}%` : '5%' }}
            />
          </div>
          <div className="flex justify-between text-xs text-gray-500">
            <span>正在校验...</span>
            <span>{verifyTotal > 0 ? `${verifyDone} / ${verifyTotal}` : ''}</span>
          </div>
        </div>
      )}

      {/* Real-time verify log */}
      {task.status === 'verifying' && recentVerifyLog.length > 0 && (
        <div className="mb-3 px-3 py-2 bg-[#111] border border-[#2a2a2a] rounded-lg">
          {recentVerifyLog.map((line, i) => (
            <p
              key={i}
              className={`text-xs font-mono leading-5 ${
                line.startsWith('✓') ? 'text-green-400' : 'text-red-400'
              }`}
            >
              {line}
            </p>
          ))}
        </div>
      )}

      {/* Active stats row */}
      {task.status === 'running' && (
        <div className="flex gap-4 text-xs mb-3">
          <div>
            <span className="text-gray-600">速度 </span>
            <span className="text-gray-300 font-mono">{formatBytes(task.speedBps)}/s</span>
          </div>
          <div>
            <span className="text-gray-600">剩余 </span>
            <span className="text-gray-300 font-mono">{formatEta(task.eta)}</span>
          </div>
          <div>
            <span className="text-gray-600">文件 </span>
            <span className="text-gray-300 font-mono">{task.completedFiles}/{task.totalFiles}</span>
          </div>
        </div>
      )}

      {/* Timing row for done tasks */}
      {isDone && task.startedAt && (
        <div className="flex gap-4 text-xs mb-3">
          <div>
            <span className="text-gray-600">开始 </span>
            <span className="text-gray-400 font-mono">{formatTime(task.startedAt)}</span>
          </div>
          {task.completedAt && (
            <>
              <div>
                <span className="text-gray-600">结束 </span>
                <span className="text-gray-400 font-mono">{formatTime(task.completedAt)}</span>
              </div>
              <div>
                <span className="text-gray-600">耗时 </span>
                <span className="text-gray-400 font-mono">{formatDuration(task.startedAt, task.completedAt)}</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Destinations — each tag clickable to reveal in Finder */}
      <div className="flex flex-wrap gap-2">
        {task.destinations.map((dest) => (
          <button
            key={dest.id}
            onClick={() => window.api.revealInFinder(dest.path)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border cursor-pointer transition-opacity hover:opacity-80
              ${dest.verified
                ? 'bg-green-500/5 border-green-500/20 text-green-400'
                : dest.error
                  ? 'bg-red-500/5 border-red-500/20 text-red-400'
                  : 'bg-[#1e1e1e] border-[#2a2a2a] text-gray-500'
              }`}
            title={`在访达中显示: ${dest.path}`}
          >
            {dest.verified ? <CheckCircle2 size={10} /> : dest.error ? <XCircle size={10} /> : null}
            <span className="max-w-[160px] truncate">
              {dest.path.split('/').pop() || dest.path}
            </span>
          </button>
        ))}
      </div>

      {/* Error */}
      {task.errorMessage && (
        <div className="mt-3 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
          {task.errorMessage}
        </div>
      )}
    </div>
  )
}
