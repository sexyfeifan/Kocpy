import { Card, Button, Badge, VStack, EmptyState } from '@astryxdesign/core'
import { useState, useMemo } from 'react'
import { useTaskStore } from '../../store/taskStore'
import { TaskCard } from '../components/TaskCard'
import { BackupHeatmap } from '../components/BackupHeatmap'
import { t } from '../../locales'
import { toDateKey } from '../../utils'

export function History(): JSX.Element {
  const { tasks } = useTaskStore()
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const done = tasks.filter((t) =>
    t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  )

  if (done.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 24 }}>
        <EmptyState heading={t('history.empty')} description={t('history.emptyDesc')} />
      </div>
    )
  }

  const filteredTasks = selectedDate
    ? done.filter((t) => {
        const ts = t.startedAt ?? t.completedAt
        return ts ? toDateKey(ts) === selectedDate : false
      })
    : done

  const totalBytes = filteredTasks.reduce((s, t) => s + t.totalBytes, 0)
  const successCount = filteredTasks.filter((t) => t.status === 'completed').length

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
      <BackupHeatmap tasks={done} selectedDate={selectedDate} onSelectDate={setSelectedDate} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--spacing-3)', marginBottom: 'var(--spacing-6)' }}>
        <Card padding={4}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', marginBottom: 4 }}>{t('history.totalTasks')}</div>
          <div style={{ fontSize: 'var(--font-size-4xl)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-text-primary)' }}>{filteredTasks.length}</div>
        </Card>
        <Card padding={4}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', marginBottom: 4 }}>{t('history.successRate')}</div>
          <div style={{ fontSize: 'var(--font-size-4xl)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-success)' }}>
            {filteredTasks.length > 0 ? Math.round((successCount / filteredTasks.length) * 100) : 0}%
          </div>
        </Card>
        <Card padding={4}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', marginBottom: 4 }}>{t('history.totalData')}</div>
          <div style={{ fontSize: 'var(--font-size-4xl)', fontWeight: 'var(--font-weight-bold)', color: 'var(--color-brand)' }}>
            {(totalBytes / 1024 / 1024 / 1024).toFixed(1)} GB
          </div>
        </Card>
      </div>

      {selectedDate && (
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-disabled)', marginBottom: 'var(--spacing-3)' }}>
          显示 {selectedDate} 的 {filteredTasks.length} {t('history.records')}
        </p>
      )}

      <VStack spacing={3}>
        {filteredTasks.map((t) => <TaskCard key={t.id} task={t} />)}
      </VStack>
    </div>
  )
}
