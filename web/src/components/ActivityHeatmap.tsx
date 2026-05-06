import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { ActivityHeatmapDay } from '@/lib/types'
import { HeatmapDayTooltip, type HoverTarget, type LoadRanking } from './HeatmapDayTooltip'

/**
 * Self-contained activity heatmap. Fetches its own data, manages its
 * own hover/ranking state, and renders the grid + totals strip + rich
 * tooltip. Used both inside the Dashboards page (with a range toggle
 * and inline chat insight) and as a passive top card on the Today
 * page (no chrome — just the grid).
 *
 * Today's cell is highlighted with an accent ring when
 * `highlightToday` is on, so the user can see where "right now" sits
 * in the year-at-a-glance frame.
 */
export function ActivityHeatmap({
  days,
  showTotals = true,
  highlightToday = false,
}: {
  days: number
  showTotals?: boolean
  highlightToday?: boolean
}) {
  const [data, setData] = useState<ActivityHeatmapDay[] | null>(null)
  const [hover, setHover] = useState<HoverTarget | null>(null)

  useEffect(() => {
    setData(null)
    api.activityHeatmap(days).then((r) => setData(r.values))
  }, [days])

  // Active-day rank (1 = hardest day in window). Rest days don't get a
  // rank since their load is zero and ranking-by-load doesn't apply.
  const ranking: LoadRanking | undefined = useMemo(() => {
    if (!data) return undefined
    const active = data.filter((d) => d.activity_count > 0)
    const sorted = [...active].sort((a, b) => b.total_load - a.total_load)
    const rankByDate = new Map<string, number>()
    sorted.forEach((d, i) => rankByDate.set(d.date, i + 1))
    return {
      rankByDate,
      totalActiveDays: active.length,
      windowLabel: rangeWindowLabel(days),
    }
  }, [data, days])

  if (data == null) {
    return (
      <div className="h-32 flex items-center justify-center">
        <Loader2 className="size-4 text-muted animate-spin" />
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <HeatmapGrid days={days} data={data} onHover={setHover} highlightToday={highlightToday} />
      {showTotals && <HeatmapTotals data={data} />}
      <HeatmapDayTooltip target={hover} ranking={ranking} />
    </div>
  )
}

const MS_DAY = 86_400_000

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function HeatmapGrid({
  days, data, onHover, highlightToday,
}: {
  days: number
  data: ActivityHeatmapDay[]
  onHover: (target: HoverTarget | null) => void
  highlightToday: boolean
}) {
  // Build the cell grid. Rows = day of week (0=Sun…6=Sat), cols = weeks.
  // Anchor on today (rightmost column) and walk back N days so the grid
  // ends exactly on today's column.
  const todayIso = useMemo(() => startOfDayUTC(new Date()).toISOString().slice(0, 10), [])

  const { weeks, maxLoad } = useMemo(() => {
    const byDate = new Map(data.map((d) => [d.date, d]))
    const today = startOfDayUTC(new Date())
    const earliestStart = startOfDayUTC(new Date(today.getTime() - (days - 1) * MS_DAY))
    // Round earliestStart down to the most recent Sunday so the first
    // column starts on a Sunday — keeps the grid aligned visually.
    const startWeek = new Date(earliestStart)
    startWeek.setUTCDate(startWeek.getUTCDate() - startWeek.getUTCDay())

    const weeks: { date: string; row: number; col: number; entry?: ActivityHeatmapDay }[] = []
    let col = 0
    let cursor = new Date(startWeek)
    while (cursor <= today) {
      for (let row = 0; row < 7; row++) {
        const cellDate = new Date(cursor.getTime() + row * MS_DAY)
        if (cellDate < earliestStart || cellDate > today) continue
        const iso = cellDate.toISOString().slice(0, 10)
        weeks.push({ date: iso, row, col, entry: byDate.get(iso) })
      }
      col++
      cursor = new Date(cursor.getTime() + 7 * MS_DAY)
    }
    const maxLoad = Math.max(50, ...data.map((d) => d.total_load))
    return { weeks, maxLoad }
  }, [data, days])

  const cellSize = 12
  const gap = 2
  const cols = Math.max(...weeks.map((w) => w.col)) + 1
  const widthPx = cols * (cellSize + gap)
  const heightPx = 7 * (cellSize + gap)

  return (
    <div className="overflow-x-auto">
      <svg
        width={widthPx}
        height={heightPx + 18}
        className="select-none"
        onMouseLeave={() => onHover(null)}
      >
        {/* Day-of-week labels — only Mon/Wed/Fri, faint */}
        {[1, 3, 5].map((dow) => (
          <text
            key={dow}
            x={-2}
            y={dow * (cellSize + gap) + cellSize - 1}
            fontSize="9"
            textAnchor="end"
            fill="var(--color-faint)"
          >
            {['', 'Mon', '', 'Wed', '', 'Fri', ''][dow]}
          </text>
        ))}
        {/* Cells */}
        {weeks.map((cell) => {
          const isActive = cell.entry && cell.entry.activity_count > 0
          const intensity = isActive
            ? Math.min(1, cell.entry!.total_load / maxLoad)
            : null
          const fill = intensity == null
            ? 'var(--color-surface-2)'
            : `oklch(${(0.32 + intensity * 0.42).toFixed(3)} ${(0.05 + intensity * 0.18).toFixed(3)} ${(155 - intensity * 130).toFixed(0)})`
          const isToday = highlightToday && cell.date === todayIso
          return (
            <rect
              key={cell.date}
              x={cell.col * (cellSize + gap)}
              y={cell.row * (cellSize + gap)}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill={fill}
              stroke={isToday ? 'var(--color-accent)' : 'var(--color-border)'}
              strokeWidth={isToday ? 1.5 : 0.5}
              className="cursor-default hover:stroke-accent-dim"
              onMouseEnter={(e) => {
                const rect = (e.target as SVGRectElement).getBoundingClientRect()
                if (cell.entry && cell.entry.activity_count > 0) {
                  onHover({ kind: 'active', day: cell.entry, rect })
                } else {
                  onHover({ kind: 'rest', day: cell.entry ?? null, date: cell.date, rect })
                }
              }}
            />
          )
        })}
      </svg>
    </div>
  )
}

function HeatmapTotals({ data }: { data: ActivityHeatmapDay[] }) {
  // Spine is daily_metrics (active + rest), so "active days" must
  // filter on activity_count rather than counting every row.
  const totals = useMemo(() => {
    const active = data.filter((d) => d.activity_count > 0)
    const days = active.length
    const totalLoad = active.reduce((s, d) => s + d.total_load, 0)
    const totalActivities = active.reduce((s, d) => s + d.activity_count, 0)
    return { days, totalLoad, totalActivities }
  }, [data])

  return (
    <div className="flex items-center justify-between text-xs text-muted gap-4 flex-wrap">
      <div className="tabular-nums">
        {totals.totalActivities} activities across {totals.days} active days · cumulative load {totals.totalLoad.toFixed(0)}
        <span className="text-faint ml-2">· hover any day for full stats</span>
      </div>
      <ScaleLegend />
    </div>
  )
}

function ScaleLegend() {
  return (
    <div className="inline-flex items-center gap-1.5 text-[10px] text-faint">
      <span>less</span>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <span
          key={t}
          className="size-3 rounded-sm border border-border"
          style={{
            background: t === 0
              ? 'var(--color-surface-2)'
              : `oklch(${(0.32 + t * 0.42).toFixed(3)} ${(0.05 + t * 0.18).toFixed(3)} ${(155 - t * 130).toFixed(0)})`,
          }}
        />
      ))}
      <span>more</span>
    </div>
  )
}

/** Plain-English window descriptor for the rank line in the tooltip
 *  ("Hardest day this year" reads better than "in 1 year"). */
function rangeWindowLabel(days: number): string {
  if (days <= 90) return `in ${days} days`
  if (days <= 180) return 'in 6 months'
  if (days <= 365) return 'this year'
  if (days <= 730) return 'in 2 years'
  return `in ${days} days`
}
