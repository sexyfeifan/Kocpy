import { useMemo, useState } from 'react'
import type { BackupTask } from '../types'
import { formatBytes, toDateKey } from '../utils'

interface DayData {
  date: string
  count: number
  bytes: number
}

interface Props {
  tasks: BackupTask[]
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
}

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
      if (existing) {
        existing.count++
        existing.bytes += t.totalBytes
      } else {
        map.set(key, { date: key, count: 1, bytes: t.totalBytes })
      }
    }
    return map
  }, [tasks])

  // Build a 52×7 grid ending today
  const cells = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // Align to Sunday of the current week
    const endSunday = new Date(today)
    endSunday.setDate(today.getDate() + (6 - today.getDay()))

    const grid: Array<{ date: string; data: DayData | null }> = []
    for (let w = WEEK_COUNT - 1; w >= 0; w--) {
      for (let d = 0; d < 7; d++) {
        const day = new Date(endSunday)
        day.setDate(endSunday.getDate() - w * 7 - (6 - d))
        const key = toDateKey(day.getTime())
        grid.push({ date: key, data: dayMap.get(key) ?? null })
      }
    }
    return grid
  }, [dayMap])

  // Month labels: find first cell of each month
  const monthLabels = useMemo(() => {
    const labels: Array<{ col: number; label: string }> = []
    let lastMonth = -1
    for (let i = 0; i < cells.length; i++) {
      const col = Math.floor(i / 7)
      const month = parseInt(cells[i].date.split('-')[1], 10) - 1
      if (month !== lastMonth) {
        labels.push({ col, label: MONTHS[month] })
        lastMonth = month
      }
    }
    return labels
  }, [cells])

  const maxCount = useMemo(() => Math.max(1, ...Array.from(dayMap.values()).map((d) => d.count)), [dayMap])

  const getColor = (data: DayData | null, date: string): string => {
    if (selectedDate === date) return 'bg-white ring-1 ring-white'
    if (!data) return 'bg-[#1a1a1a] hover:bg-[#252525]'
    const intensity = data.count / maxCount
    if (intensity < 0.25) return 'bg-blue-900/60 hover:bg-blue-800/70'
    if (intensity < 0.5) return 'bg-blue-700/70 hover:bg-blue-600/80'
    if (intensity < 0.75) return 'bg-blue-500/80 hover:bg-blue-400/90'
    return 'bg-blue-400 hover:bg-blue-300'
  }

  const handleMouseEnter = (e: React.MouseEvent, cell: { date: string; data: DayData | null }) => {
    if (!cell.data) return
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    const x = Math.max(70, Math.min(window.innerWidth - 70, rect.left + rect.width / 2))
    setTooltip({ x, y: rect.top - 8, data: cell.data })
  }

  const handleClick = (date: string, data: DayData | null) => {
    if (!data) return
    onSelectDate(selectedDate === date ? null : date)
  }

  return (
    <div className="glass-card p-5 mb-6 select-none">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">备份热力图</span>
        {selectedDate && (
          <button
            onClick={() => onSelectDate(null)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            清除筛选 ×
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        {/* Month labels */}
        <div className="relative mb-1" style={{ marginLeft: 20, height: 14 }}>
          {monthLabels.map(({ col, label }) => (
            <span
              key={`${col}-${label}`}
              className="absolute text-[10px] text-gray-600"
              style={{ left: col * 13 }}
            >
              {label}
            </span>
          ))}
        </div>

        <div className="flex gap-0.5">
          {/* Day-of-week labels */}
          <div className="flex flex-col gap-0.5 mr-1 shrink-0">
            {DAYS.map((d, i) => (
              <span
                key={d}
                className="text-[9px] text-gray-700 leading-none flex items-center justify-end"
                style={{ height: 11, visibility: i % 2 === 1 ? 'visible' : 'hidden' }}
              >
                {d}
              </span>
            ))}
          </div>

          {/* Grid: columns = weeks */}
          <div className="flex gap-0.5">
            {Array.from({ length: WEEK_COUNT }, (_, w) => (
              <div key={w} className="flex flex-col gap-0.5">
                {cells.slice(w * 7, w * 7 + 7).map((cell) => (
                  <div
                    key={cell.date}
                    className={`w-2.5 h-2.5 rounded-[2px] cursor-pointer transition-colors ${getColor(cell.data, cell.date)}`}
                    onMouseEnter={(e) => handleMouseEnter(e, cell)}
                    onMouseLeave={() => setTooltip(null)}
                    onClick={() => handleClick(cell.date, cell.data)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-1 mt-2 justify-end">
          <span className="text-[10px] text-gray-700 mr-1">少</span>
          {['bg-[#1a1a1a]', 'bg-blue-900/60', 'bg-blue-700/70', 'bg-blue-500/80', 'bg-blue-400'].map((c) => (
            <div key={c} className={`w-2.5 h-2.5 rounded-[2px] ${c}`} />
          ))}
          <span className="text-[10px] text-gray-700 ml-1">多</span>
        </div>
      </div>

      {/* Tooltip — portal-like fixed positioning */}
      {tooltip && (
        <div
          className="fixed z-50 pointer-events-none px-2.5 py-1.5 bg-[#1e1e1e] border border-[#333] rounded-lg shadow-xl text-xs text-gray-200"
          style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}
        >
          <p className="font-medium">{tooltip.data.date}</p>
          <p className="text-gray-400">{tooltip.data.count} 次备份 · {formatBytes(tooltip.data.bytes)}</p>
        </div>
      )}
    </div>
  )
}
