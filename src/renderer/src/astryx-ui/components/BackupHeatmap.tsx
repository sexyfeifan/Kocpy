import { Card, Button } from '@astryxdesign/core'
import { useMemo, useState } from 'react'
import type { BackupTask } from '../../types'
import { formatBytes, toDateKey } from '../../utils'
import { t } from '../../locales'

interface DayData { date: string; count: number; bytes: number }
interface Props { tasks: BackupTask[]; selectedDate: string | null; onSelectDate: (date: string | null) => void }

const WEEK_COUNT = 52
const DAYS = ['日', '一', '二', '三', '四', '五', '六']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function BackupHeatmap({ tasks, selectedDate, onSelectDate }: Props): JSX.Element {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; data: DayData } | null>(null)

  const dayMap = useMemo(() => {
    const map = new Map<string, DayData>()
    for (const t of tasks) {
      if (t.status !== 'completed') continue
      const ts = t.startedAt ?? t.completedAt
      if (!ts) continue
      const key = toDateKey(ts)
      const existing = map.get(key)
      if (existing) { existing.count++; existing.bytes += t.totalBytes }
      else map.set(key, { date: key, count: 1, bytes: t.totalBytes })
    }
    return map
  }, [tasks])

  const cells = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const endSunday = new Date(today); endSunday.setDate(today.getDate() + (6 - today.getDay()))
    const grid: Array<{ date: string; data: DayData | null }> = []
    for (let w = WEEK_COUNT - 1; w >= 0; w--) {
      for (let d = 0; d < 7; d++) {
        const day = new Date(endSunday); day.setDate(endSunday.getDate() - w * 7 - (6 - d))
        const key = toDateKey(day.getTime())
        grid.push({ date: key, data: dayMap.get(key) ?? null })
      }
    }
    return grid
  }, [dayMap])

  const monthLabels = useMemo(() => {
    const labels: Array<{ col: number; label: string }> = []
    let lastMonth = -1
    for (let i = 0; i < cells.length; i++) {
      const col = Math.floor(i / 7)
      const month = parseInt(cells[i].date.split('-')[1], 10) - 1
      if (month !== lastMonth) { labels.push({ col, label: MONTHS[month] }); lastMonth = month }
    }
    return labels
  }, [cells])

  const maxCount = useMemo(() => Math.max(1, ...Array.from(dayMap.values()).map((d) => d.count)), [dayMap])

  const getColor = (data: DayData | null, date: string): string => {
    if (selectedDate === date) return 'var(--color-text-primary)'
    if (!data) return 'var(--color-background-muted)'
    const intensity = data.count / maxCount
    // Use Astryx blue sequential scale
    if (intensity < 0.25) return '#02165E' // data-blue-5
    if (intensity < 0.5) return '#004CBC'  // data-blue-4
    if (intensity < 0.75) return '#2694FE' // data-blue-3
    return '#78BEFF'                        // data-blue-2
  }

  return (
    <Card padding={5} className="kocpy-slide-in" style={{ marginBottom: 'var(--spacing-6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-3)' }}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {t('heatmap.title')}
        </span>
        {selectedDate && (
          <Button label={t('heatmap.clearFilter')} variant="ghost" size="sm" onClick={() => onSelectDate(null)} />
        )}
      </div>

      <div style={{ overflow: 'auto' }}>
        {/* Month labels */}
        <div style={{ position: 'relative', marginLeft: 20, height: 14, marginBottom: 4 }}>
          {monthLabels.map(({ col, label }) => (
            <span key={`${col}-${label}`} style={{ position: 'absolute', left: col * 13, fontSize: 10, color: 'var(--color-text-disabled)' }}>{label}</span>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 2 }}>
          {/* Day labels */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 4, flexShrink: 0 }}>
            {DAYS.map((d, i) => (
              <span key={d} style={{ fontSize: 9, color: 'var(--color-text-disabled)', height: 11, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', visibility: i % 2 === 1 ? 'visible' : 'hidden' }}>{d}</span>
            ))}
          </div>

          {/* Grid */}
          <div style={{ display: 'flex', gap: 2 }}>
            {Array.from({ length: WEEK_COUNT }, (_, w) => (
              <div key={w} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {cells.slice(w * 7, w * 7 + 7).map((cell) => (
                  <div
                    key={cell.date}
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      cursor: 'pointer',
                      background: getColor(cell.data, cell.date),
                      transition: 'background var(--duration-fast) var(--ease-standard)',
                      outline: selectedDate === cell.date ? '1px solid var(--color-text-primary)' : 'none',
                    }}
                    onMouseEnter={(e) => { if (cell.data) { const r = (e.target as HTMLElement).getBoundingClientRect(); setTooltip({ x: r.left + r.width / 2, y: r.top - 8, data: cell.data }) } }}
                    onMouseLeave={() => setTooltip(null)}
                    onClick={() => { if (cell.data) onSelectDate(selectedDate === cell.date ? null : cell.date) }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 10, color: 'var(--color-text-disabled)', marginRight: 4 }}>{t('heatmap.less')}</span>
          {['var(--color-background-muted)', '#02165E', '#004CBC', '#2694FE', '#78BEFF'].map((c) => (
            <div key={c} style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
          ))}
          <span style={{ fontSize: 10, color: 'var(--color-text-disabled)', marginLeft: 4 }}>{t('heatmap.more')}</span>
        </div>
      </div>

      {tooltip && (
        <div style={{
          position: 'fixed',
          zIndex: 50,
          pointerEvents: 'none',
          padding: '6px 10px',
          background: 'var(--color-background-popover)',
          border: '1px solid var(--color-border-emphasized)',
          borderRadius: 'var(--radius-inner)',
          boxShadow: 'var(--shadow-med)',
          fontSize: 'var(--font-size-sm)',
          color: 'var(--color-text-primary)',
          left: tooltip.x,
          top: tooltip.y,
          transform: 'translate(-50%, -100%)',
        }}>
          <p style={{ fontWeight: 'var(--font-weight-medium)', margin: 0 }}>{tooltip.data.date}</p>
          <p style={{ color: 'var(--color-text-secondary)', margin: 0 }}>{tooltip.data.count} {t('heatmap.backups')} · {formatBytes(tooltip.data.bytes)}</p>
        </div>
      )}
    </Card>
  )
}
