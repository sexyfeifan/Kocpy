import { Card, Button, Badge, HStack } from '@astryxdesign/core'
import type { BackupTask } from '../../types'
import { useTaskStore } from '../../store/taskStore'
import { useState } from 'react'
import { formatBytes, formatEta, formatDuration, formatTime } from '../../utils'
import { t } from '../../locales'

const STATUS_CONFIG = {
  pending:   { color: 'var(--color-text-secondary)', badge: 'neutral',  labelKey: 'task.pending' },
  running:   { color: 'var(--color-brand)',          badge: 'info',     labelKey: 'task.running' },
  verifying: { color: 'var(--color-warning)',        badge: 'warning',  labelKey: 'task.verifying' },
  completed: { color: 'var(--color-success)',        badge: 'success',  labelKey: 'task.completed' },
  failed:    { color: 'var(--color-error)',          badge: 'error',    labelKey: 'task.failed' },
  cancelled: { color: 'var(--color-text-disabled)',  badge: 'neutral',  labelKey: 'task.cancelled' },
}

interface Props { task: BackupTask }

export function TaskCard({ task }: Props): JSX.Element {
  const { deleteTask, setPriority } = useTaskStore()
  const cfg = STATUS_CONFIG[task.status]
  const progress = task.totalBytes > 0 ? (task.transferredBytes / task.totalBytes) * 100 : 0
  const isActive = task.status === 'running' || task.status === 'verifying'
  const isDone = !isActive

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const verifyTotal = task.verifyTotalFiles ?? 0
  const verifyDone = task.verifyCompletedFiles ?? 0
  const verifyProgress = verifyTotal > 0 ? (verifyDone / verifyTotal) * 100 : 0

  const recentVerifyLog = task.verifyLog ? task.verifyLog.slice(-3) : []

  return (
    <Card padding={4} className="kocpy-slide-in">
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 'var(--spacing-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Badge
              label={t(cfg.labelKey)}
              variant={cfg.badge as any}
              isLoading={isActive}
            />
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', fontFamily: 'var(--font-family-code)' }}>
              {task.hashAlgorithm.toUpperCase()}
            </span>
            {task.priority && <Badge label={t('task.priority')} variant="warning" />}
            {task.incremental && <Badge label="增量" variant="success" />}
          </div>

          <h3 style={{
            fontSize: 'var(--font-size-base)',
            fontWeight: 'var(--font-weight-semibold)',
            color: 'var(--color-text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>{task.name}</h3>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <Badge label={t('task.dataSource')} variant="warning" />
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {task.sourcePath}
            </span>
          </div>

          {task.destinations.map((dest) => (
            <div key={dest.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <Badge label={t('task.backupPath')} variant="info" />
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {dest.path}
              </span>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12, flexShrink: 0 }}>
          {task.status === 'pending' && (
            <Button
              label={task.priority ? '取消优先' : '设为优先'}
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<ZapIcon />}
              onClick={() => setPriority(task.id, !task.priority)}
            />
          )}
          {isActive && (
            confirmCancel ? (
              <HStack spacing={1}>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-error)' }}>{t('task.confirmCancel')}</span>
                <Button label={t('task.confirm')} variant="destructive" size="sm" onClick={() => window.api.cancelTask(task.id)} />
                <Button label={t('common.cancel')} variant="ghost" size="sm" onClick={() => setConfirmCancel(false)} />
              </HStack>
            ) : (
              <Button label={t('task.cancel')} variant="ghost" size="sm" isIconOnly icon={<StopIcon />} onClick={() => setConfirmCancel(true)} />
            )
          )}
          {(task.status === 'completed' || task.status === 'failed') && (
            <Button
              label={t('task.exportReport')}
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<DownloadIcon />}
              onClick={async () => {
                const savePath = await window.api.saveReport(task.name)
                if (savePath) {
                  await window.api.generateReport(task.id, savePath)
                  window.api.revealInFinder(savePath)
                }
              }}
            />
          )}
          {isDone && (
            confirmDelete ? (
              <HStack spacing={1}>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-error)' }}>{t('task.confirmDelete')}</span>
                <Button label={t('task.confirm')} variant="destructive" size="sm" onClick={() => deleteTask(task.id)} />
                <Button label={t('common.cancel')} variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} />
              </HStack>
            ) : (
              <Button label={t('task.deleteRecord')} variant="ghost" size="sm" isIconOnly icon={<TrashIcon />} onClick={() => setConfirmDelete(true)} />
            )
          )}
        </div>
      </div>

      {/* Completion banner */}
      {task.status === 'completed' && (
        <div style={{
          marginBottom: 'var(--spacing-3)',
          padding: 'var(--spacing-2) var(--spacing-3)',
          background: 'var(--color-success-muted)',
          border: '1px solid var(--color-success)',
          borderRadius: 'var(--radius-inner)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-success)',
        }}>
          ✓ 备份完成 — 全部 {task.totalFiles} {t('task.filesChecked')}
          {(task.unchangedFiles ?? 0) > 0 && `（增量跳过 ${task.unchangedFiles} 个未变更文件）`}
          {(task.skippedFiles ?? 0) > 0 && `（跳过 ${task.skippedFiles} 个隐藏文件，共 ${formatBytes(task.skippedBytes ?? 0)}）`}
        </div>
      )}

      {/* Error banner */}
      {task.status === 'failed' && (
        <div style={{
          marginBottom: 'var(--spacing-3)',
          padding: 'var(--spacing-2) var(--spacing-3)',
          background: 'var(--color-error-muted)',
          border: '1px solid var(--color-error)',
          borderRadius: 'var(--radius-inner)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-error)',
        }}>✗ {t('task.backupFailed')}</div>
      )}

      {/* Copy progress bar */}
      {(task.status === 'running' || task.status === 'completed') && (
        <div style={{ marginBottom: 'var(--spacing-3)' }}>
          <div className="kocpy-progress-track">
            <div
              className="kocpy-progress-fill"
              style={{
                width: task.status === 'completed' ? '100%' : `${progress}%`,
                background: task.status === 'completed' ? 'var(--color-success)' : 'var(--color-brand)',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            <span>{task.status === 'completed' ? `${task.totalFiles} 个文件` : task.currentFile || t('task.preparing')}</span>
            <span>{task.status === 'completed' ? formatBytes(task.totalBytes) : `${formatBytes(task.transferredBytes)} / ${formatBytes(task.totalBytes)}`}</span>
          </div>
        </div>
      )}

      {/* Verify progress */}
      {task.status === 'verifying' && (
        <div style={{ marginBottom: 'var(--spacing-3)' }}>
          <div className="kocpy-progress-track">
            <div className="kocpy-progress-fill" style={{ width: verifyTotal > 0 ? `${verifyProgress}%` : '5%', background: 'var(--color-warning)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            <span>{t('task.verifyingStatus')}</span>
            <span>{verifyTotal > 0 ? `${verifyDone} / ${verifyTotal}` : ''}</span>
          </div>
        </div>
      )}

      {/* Verify log */}
      {task.status === 'verifying' && recentVerifyLog.length > 0 && (
        <div style={{
          marginBottom: 'var(--spacing-3)',
          padding: 'var(--spacing-2) var(--spacing-3)',
          background: 'var(--color-background-muted)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-inner)',
        }}>
          {recentVerifyLog.map((line, i) => (
            <p key={i} style={{
              fontSize: 'var(--font-size-sm)',
              fontFamily: 'var(--font-family-code)',
              lineHeight: 1.67,
              color: line.startsWith('✓') ? 'var(--color-success)' : line.startsWith('⊙') ? 'var(--color-text-disabled)' : 'var(--color-error)',
              margin: 0,
            }}>{line}</p>
          ))}
        </div>
      )}

      {/* Active stats */}
      {task.status === 'running' && (
        <div style={{ display: 'flex', gap: 'var(--spacing-4)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-3)' }}>
          <div><span style={{ color: 'var(--color-text-disabled)' }}>{t('task.speed')} </span><span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-family-code)' }}>{formatBytes(task.speedBps)}/s</span></div>
          <div><span style={{ color: 'var(--color-text-disabled)' }}>{t('task.remaining')} </span><span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-family-code)' }}>{formatEta(task.eta)}</span></div>
          <div><span style={{ color: 'var(--color-text-disabled)' }}>{t('task.files')} </span><span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-family-code)' }}>{task.completedFiles}/{task.totalFiles}</span></div>
        </div>
      )}

      {/* Timing */}
      {isDone && task.startedAt && (
        <div style={{ display: 'flex', gap: 'var(--spacing-4)', fontSize: 'var(--font-size-sm)', marginBottom: 'var(--spacing-3)' }}>
          <div><span style={{ color: 'var(--color-text-disabled)' }}>{t('task.start')} </span><span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-family-code)' }}>{formatTime(task.startedAt)}</span></div>
          {task.completedAt && (
            <>
              <div><span style={{ color: 'var(--color-text-disabled)' }}>{t('task.end')} </span><span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-family-code)' }}>{formatTime(task.completedAt)}</span></div>
              <div><span style={{ color: 'var(--color-text-disabled)' }}>{t('task.duration')} </span><span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-family-code)' }}>{formatDuration(task.startedAt, task.completedAt)}</span></div>
            </>
          )}
        </div>
      )}

      {/* Destinations */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-2)' }}>
        {task.destinations.map((dest) => (
          <Button
            key={dest.id}
            label={dest.path.split('/').pop() || dest.path}
            variant="secondary"
            size="sm"
            icon={dest.verified ? <CheckIcon /> : dest.error ? <XIcon /> : undefined}
            onClick={() => window.api.revealInFinder(dest.path)}
            tooltip={`在访达中显示: ${dest.path}`}
          />
        ))}
      </div>

      {task.errorMessage && (
        <div style={{
          marginTop: 'var(--spacing-3)',
          padding: 'var(--spacing-2) var(--spacing-3)',
          background: 'var(--color-error-muted)',
          border: '1px solid var(--color-error)',
          borderRadius: 'var(--radius-inner)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-error)',
        }}>{task.errorMessage}</div>
      )}
    </Card>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────

function ZapIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
}
function StopIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><rect x="9" y="9" width="6" height="6" /></svg>
}
function DownloadIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
}
function TrashIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
}
function CheckIcon() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
}
function XIcon() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
}
