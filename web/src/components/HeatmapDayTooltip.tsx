import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Bike, Dumbbell, Footprints, HandMetal, Mountain, Waves } from 'lucide-react'
import { api } from '@/lib/api'
import type {
  ActivityHeatmapDay, ActivityHeatmapDayResponse, HeatmapActivity,
} from '@/lib/types'
import { fmtKm, fmtPace, fmtSeconds } from '@/lib/utils'

/**
 * Floating popover that appears next to the hovered heatmap cell. Shows
 * everything that informed the cell's color: per-activity detail, raw
 * recovery markers with delta-from-baseline coloring, and the day's
 * Banister CTL/ATL/TSB state.
 *
 * Two render modes:
 *   - "active day": full day data is in the heatmap response; render
 *     immediately, no extra fetch.
 *   - "rest day": tooltip lazy-loads `/api/activity-heatmap-day/{date}`
 *     so wellness + load state still appear without bloating the
 *     initial heatmap payload.
 *
 * Uses a portal anchored to document.body so the SVG's overflow doesn't
 * clip the popover. Position is clamped to the viewport so cells near
 * the right edge flip the tooltip to the left side.
 */

const TOOLTIP_WIDTH = 320
const TOOLTIP_OFFSET = 14

export type HoverTarget =
  | { kind: 'active'; day: ActivityHeatmapDay; rect: DOMRect }
  | { kind: 'rest'; date: string; rect: DOMRect }

export function HeatmapDayTooltip({ target }: { target: HoverTarget | null }) {
  // Cache rest-day fetches so re-hovering the same cell doesn't refetch.
  const cacheRef = useRef<Map<string, ActivityHeatmapDayResponse>>(new Map())
  const [restDayData, setRestDayData] = useState<ActivityHeatmapDayResponse | null>(null)
  const [restDayLoading, setRestDayLoading] = useState(false)

  useEffect(() => {
    if (!target || target.kind !== 'rest') {
      setRestDayData(null)
      setRestDayLoading(false)
      return
    }
    const cached = cacheRef.current.get(target.date)
    if (cached) {
      setRestDayData(cached)
      return
    }
    setRestDayData(null)
    setRestDayLoading(true)
    let cancelled = false
    api.activityHeatmapDay(target.date)
      .then((d) => {
        if (cancelled) return
        cacheRef.current.set(target.date, d)
        setRestDayData(d)
      })
      .catch(() => { /* missing data shows the empty state anyway */ })
      .finally(() => { if (!cancelled) setRestDayLoading(false) })
    return () => { cancelled = true }
  }, [target])

  if (!target) return null

  // Compute viewport-clamped position. Default: right of the cell.
  // Flip to the left side if the right side would clip.
  const cellMidY = target.rect.top + target.rect.height / 2
  let left = target.rect.right + TOOLTIP_OFFSET
  if (left + TOOLTIP_WIDTH > window.innerWidth - 8) {
    left = target.rect.left - TOOLTIP_WIDTH - TOOLTIP_OFFSET
  }
  let top = cellMidY - 100  // anchor near vertical mid; height varies
  top = Math.max(8, Math.min(window.innerHeight - 360, top))

  const dateIso = target.kind === 'active' ? target.day.date : target.date
  const dateObj = new Date(dateIso + 'T00:00:00')
  const dayHeader = dateObj.toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
  })

  return createPortal(
    <div
      role="tooltip"
      style={{ position: 'fixed', top, left, width: TOOLTIP_WIDTH, zIndex: 60 }}
      className="pointer-events-none bg-surface-2 border border-border rounded-xl shadow-elev p-4 space-y-3 text-[12px] text-text"
    >
      <header className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-text">{dayHeader}</span>
        {target.kind === 'rest' && (
          <span className="text-[10px] uppercase tracking-wider text-faint">Rest</span>
        )}
      </header>

      {target.kind === 'active' ? (
        <ActiveDaySection day={target.day} />
      ) : (
        <RestDaySection date={target.date} data={restDayData} loading={restDayLoading} />
      )}
    </div>,
    document.body,
  )
}

function ActiveDaySection({ day }: { day: ActivityHeatmapDay }) {
  return (
    <>
      <LoadHeader load={day.total_load} count={day.activity_count} duration={day.total_duration_seconds} />
      {day.activities.length > 0 && <ActivitiesList activities={day.activities} />}
      <RecoverySection
        wellness={day.wellness}
        baseline={day.baseline}
      />
      <LoadStateSection load_state={day.load_state} />
    </>
  )
}

function RestDaySection({
  date, data, loading,
}: {
  date: string
  data: ActivityHeatmapDayResponse | null
  loading: boolean
}) {
  if (loading || !data) {
    return <div className="text-muted text-[12px]">Loading recovery…</div>
  }
  const hasAnyWellness = data.wellness && Object.values(data.wellness).some((v) => v != null)
  if (!hasAnyWellness && !data.load_state?.ctl) {
    return (
      <div className="text-muted text-[12px]">
        No watch data recorded for {date}.
      </div>
    )
  }
  return (
    <>
      <div className="text-[12px] text-muted">No activities — recovery day.</div>
      {data.wellness && data.baseline && (
        <RecoverySection wellness={data.wellness} baseline={data.baseline} />
      )}
      {data.load_state && <LoadStateSection load_state={data.load_state} />}
    </>
  )
}

// =====================================================================
// Sections
// =====================================================================

function LoadHeader({
  load, count, duration,
}: {
  load: number
  count: number
  duration: number
}) {
  const tone = loadTone(load)
  return (
    <div className="flex items-baseline justify-between border-b border-border/60 pb-2">
      <div>
        <div className={`text-[18px] font-semibold tabular-nums ${tone}`}>
          {load.toFixed(0)}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-faint mt-0.5">Training load</div>
      </div>
      <div className="text-right">
        <div className="text-[12px] text-muted tabular-nums">
          {count} {count === 1 ? 'activity' : 'activities'} · {fmtSeconds(duration)}
        </div>
      </div>
    </div>
  )
}

function ActivitiesList({ activities }: { activities: HeatmapActivity[] }) {
  return (
    <div className="space-y-2">
      <SectionLabel>Activities</SectionLabel>
      <div className="space-y-1.5">
        {activities.map((a) => {
          const Icon = activityIcon(a.type)
          return (
            <div key={a.activity_id} className="flex items-start gap-2">
              <span className="size-5 rounded-md bg-surface flex items-center justify-center shrink-0 mt-0.5">
                <Icon className="size-3 text-muted" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] capitalize text-text">
                  {a.type.replace(/_/g, ' ')}
                </div>
                <div className="text-[11px] text-muted tabular-nums flex flex-wrap gap-x-2 gap-y-0">
                  {a.distance_meters != null && <span>{fmtKm(a.distance_meters)}</span>}
                  {a.duration_seconds != null && <span>· {fmtSeconds(a.duration_seconds)}</span>}
                  {a.avg_pace_sec_per_km != null && a.avg_pace_sec_per_km > 0 && (
                    <span>· {fmtPace(a.avg_pace_sec_per_km)}</span>
                  )}
                  {a.avg_hr != null && <span>· HR {a.avg_hr}</span>}
                </div>
              </div>
              {a.training_load != null && (
                <span className="text-[11px] text-muted tabular-nums shrink-0">
                  +{a.training_load.toFixed(0)}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RecoverySection({
  wellness, baseline,
}: {
  wellness: { rhr: number | null; sleep_seconds: number | null; sleep_score: number | null; body_battery_max: number | null; avg_stress: number | null; steps: number | null }
  baseline: { rhr_60d: number | null; sleep_seconds_60d: number | null; body_battery_max_60d: number | null; stress_60d: number | null }
}) {
  return (
    <div className="space-y-1.5">
      <SectionLabel>Recovery markers</SectionLabel>
      <Row
        label="Resting HR"
        value={wellness.rhr != null ? `${wellness.rhr} bpm` : '—'}
        delta={wellness.rhr != null && baseline.rhr_60d != null
          ? deltaTone(wellness.rhr - baseline.rhr_60d, { lowerIsBetter: true })
          : null}
      />
      <Row
        label="Sleep"
        value={wellness.sleep_seconds != null ? fmtHM(wellness.sleep_seconds) : '—'}
        sub={wellness.sleep_score != null ? `score ${wellness.sleep_score}` : undefined}
        delta={wellness.sleep_seconds != null && baseline.sleep_seconds_60d != null
          ? deltaTone(wellness.sleep_seconds - baseline.sleep_seconds_60d, { lowerIsBetter: false, decimals: 0, unit: 'm', scale: 1 / 60 })
          : null}
      />
      <Row
        label="Body Battery"
        value={wellness.body_battery_max != null ? `${wellness.body_battery_max} peak` : '—'}
        delta={wellness.body_battery_max != null && baseline.body_battery_max_60d != null
          ? deltaTone(wellness.body_battery_max - baseline.body_battery_max_60d, { lowerIsBetter: false })
          : null}
      />
      <Row
        label="Avg stress"
        value={wellness.avg_stress != null ? `${wellness.avg_stress}` : '—'}
        delta={wellness.avg_stress != null && baseline.stress_60d != null
          ? deltaTone(wellness.avg_stress - baseline.stress_60d, { lowerIsBetter: true })
          : null}
      />
      {wellness.steps != null && (
        <Row label="Steps" value={wellness.steps.toLocaleString()} />
      )}
    </div>
  )
}

function LoadStateSection({
  load_state,
}: {
  load_state: { ctl: number | null; atl: number | null; tsb: number | null }
}) {
  if (load_state.ctl == null && load_state.atl == null && load_state.tsb == null) return null
  return (
    <div className="space-y-1.5">
      <SectionLabel>Training-load state</SectionLabel>
      <Row
        label="CTL · fitness"
        value={fmtNum(load_state.ctl, 1)}
      />
      <Row
        label="ATL · fatigue"
        value={fmtNum(load_state.atl, 1)}
      />
      <Row
        label="TSB · form"
        value={fmtNum(load_state.tsb, 1)}
        sub={tsbTag(load_state.tsb)}
        valueTone={tsbValueTone(load_state.tsb)}
      />
    </div>
  )
}

// =====================================================================
// Atoms
// =====================================================================

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-faint">
      {children}
    </div>
  )
}

function Row({
  label, value, sub, delta, valueTone,
}: {
  label: string
  value: string
  sub?: string
  delta?: { text: string; tone: 'good' | 'bad' | 'neutral' } | null
  valueTone?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="flex items-baseline gap-1.5 tabular-nums">
        {sub && <span className="text-[10px] text-faint">{sub}</span>}
        <span className={`text-[12px] ${valueTone ?? 'text-text'}`}>{value}</span>
        {delta && (
          <span className={`text-[10px] tabular-nums ${toneClass(delta.tone)}`}>
            {delta.text}
          </span>
        )}
      </span>
    </div>
  )
}

// =====================================================================
// helpers
// =====================================================================

function deltaTone(
  diff: number,
  opts: { lowerIsBetter: boolean; decimals?: number; unit?: string; scale?: number },
): { text: string; tone: 'good' | 'bad' | 'neutral' } {
  const scaled = (opts.scale ?? 1) * diff
  if (Math.abs(scaled) < 0.5) return { text: '', tone: 'neutral' }
  const sign = scaled > 0 ? '+' : ''
  const text = `${sign}${scaled.toFixed(opts.decimals ?? 1)}${opts.unit ?? ''}`
  const isHigher = scaled > 0
  const tone = opts.lowerIsBetter
    ? isHigher ? 'bad' : 'good'
    : isHigher ? 'good' : 'bad'
  return { text, tone }
}

function toneClass(tone: 'good' | 'bad' | 'neutral'): string {
  if (tone === 'good') return 'text-good'
  if (tone === 'bad') return 'text-bad'
  return 'text-faint'
}

function loadTone(load: number): string {
  if (load >= 150) return 'text-bad'
  if (load >= 80) return 'text-warn'
  if (load >= 30) return 'text-accent'
  return 'text-text'
}

function fmtNum(v: number | null, decimals: number): string {
  if (v == null) return '—'
  return v.toFixed(decimals)
}

function fmtHM(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function tsbTag(tsb: number | null): string | undefined {
  if (tsb == null) return undefined
  if (tsb < -10) return 'overreaching'
  if (tsb < 5) return 'productive'
  if (tsb < 25) return 'fresh'
  return 'detraining'
}

function tsbValueTone(tsb: number | null): string {
  if (tsb == null) return 'text-text'
  if (tsb < -15) return 'text-bad'
  if (tsb > 25) return 'text-warn'
  return 'text-text'
}

function activityIcon(type: string) {
  const t = (type || '').toLowerCase()
  if (t.includes('run') || t.includes('treadmill')) return Footprints
  if (t.includes('walk')) return Footprints
  if (t.includes('hik') || t.includes('trail')) return Mountain
  if (t.includes('cycl') || t.includes('bik')) return Bike
  if (t.includes('swim')) return Waves
  if (t.includes('strength') || t.includes('weight')) return Dumbbell
  if (t.includes('yoga') || t.includes('stretch')) return HandMetal
  return Activity
}
