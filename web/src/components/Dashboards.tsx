import { useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { ActivityHeatmap } from './ActivityHeatmap'
import { Card, CardBody, CardHeader, CardTitle } from './Card'
import { fmtDate, fmtDateShort } from '@/lib/utils'
import type { PaceEfficiencyRun, StrengthVolumeWeek } from '@/lib/types'

/**
 * Custom dashboards page. Charts + range toggles only — conversational
 * analysis of these views now lives in the agent (Claude Desktop/Code/
 * Mobile pointed at the fitness MCP).
 */
export function Dashboards() {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm text-muted">Custom views</div>
            <h1 className="text-2xl font-semibold tracking-tight mt-0.5">Dashboards</h1>
          </div>
        </header>

        <ActivityHeatmapPanel />
        <PaceEfficiencyPanel />
        <StrengthTrackerPanel />
      </div>
    </div>
  )
}

// =====================================================================
// Activity heatmap — calendar-style year view (52 weeks × 7 days)
// =====================================================================

const HEATMAP_RANGES = [
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
  { label: '2y', days: 730 },
] as const

function ActivityHeatmapPanel() {
  const [days, setDays] = useState<number>(365)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <CardTitle>Activity heatmap</CardTitle>
          <RangeToggle
            options={HEATMAP_RANGES.map((r) => ({ label: r.label, value: r.days }))}
            value={days}
            onChange={setDays}
          />
        </div>
      </CardHeader>
      <CardBody>
        <div className="space-y-3">
          <ActivityHeatmap days={days} />
        </div>
      </CardBody>
    </Card>
  )
}

// =====================================================================
// Pace efficiency — HR-per-kmh trend with TSB overlay
// =====================================================================

const PACE_RANGES = [
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
  { label: '2y', days: 730 },
] as const

function PaceEfficiencyPanel() {
  const [days, setDays] = useState<number>(180)
  const [runs, setRuns] = useState<PaceEfficiencyRun[] | null>(null)

  useEffect(() => {
    setRuns(null)
    api.paceEfficiency(days, 2).then((r) => setRuns(r.values))
  }, [days])

  // Rolling 5-run average of hr_per_kmh — smooths noise so the trend is
  // visible without losing per-run dots. TSB stays on its own axis.
  const smoothed = useMemo(() => {
    if (!runs) return null
    const out: { date: string; hr_per_kmh: number; rolling: number | null; tsb: number | null }[] = []
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]
      if (r.hr_per_kmh == null) continue
      const window = runs.slice(Math.max(0, i - 4), i + 1)
        .map((x) => x.hr_per_kmh)
        .filter((v): v is number => v != null)
      const rolling = window.length >= 3
        ? window.reduce((s, v) => s + v, 0) / window.length
        : null
      out.push({
        date: r.date,
        hr_per_kmh: r.hr_per_kmh,
        rolling,
        tsb: r.tsb,
      })
    }
    return out
  }, [runs])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Pace efficiency &amp; fatigue</CardTitle>
            <p className="text-[11px] text-faint mt-1">
              HR per km/h on each run. Rising line = more cardiovascular cost for
              the same speed (fatigue / detraining). TSB overlay shows whether
              the rise tracks intentional load.
            </p>
          </div>
          <RangeToggle
            options={PACE_RANGES.map((r) => ({ label: r.label, value: r.days }))}
            value={days}
            onChange={setDays}
          />
        </div>
      </CardHeader>
      <CardBody>
        <div className="h-80">
          {smoothed == null ? (
            <ChartLoading />
          ) : smoothed.length === 0 ? (
            <EmptyState>
              No runs in this window with both HR and pace recorded.
            </EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={smoothed} margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                  tickFormatter={fmtDateShort}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  tickLine={false}
                  minTickGap={50}
                />
                <YAxis
                  yAxisId="hr"
                  tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  domain={['auto', 'auto']}
                />
                <YAxis
                  yAxisId="tsb"
                  orientation="right"
                  tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                  domain={['auto', 'auto']}
                />
                <Tooltip content={<PaceTooltip />} />
                <ReferenceLine yAxisId="tsb" y={0} stroke="var(--color-border)" />
                {/* per-run dots */}
                <Line
                  yAxisId="hr"
                  dataKey="hr_per_kmh"
                  stroke="oklch(0.78 0.16 28)"
                  strokeWidth={0}
                  dot={{ r: 2.5, fill: 'oklch(0.78 0.16 28)', strokeWidth: 0 }}
                  name="Per-run HR/km·h"
                  isAnimationActive={false}
                />
                {/* rolling smoother */}
                <Line
                  yAxisId="hr"
                  dataKey="rolling"
                  stroke="oklch(0.78 0.16 28)"
                  strokeWidth={2}
                  dot={false}
                  type="monotone"
                  name="5-run rolling"
                  isAnimationActive={false}
                />
                {/* TSB on right axis */}
                <Line
                  yAxisId="tsb"
                  dataKey="tsb"
                  stroke="oklch(0.78 0.16 158)"
                  strokeWidth={1.6}
                  strokeDasharray="3 3"
                  dot={false}
                  type="monotone"
                  name="TSB"
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="flex gap-4 text-[11px] text-muted mt-3">
          <Legend color="oklch(0.78 0.16 28)" label="HR per km/h (lower is better)" />
          <Legend color="oklch(0.78 0.16 158)" label="TSB — negative = accumulated fatigue" />
        </div>
      </CardBody>
    </Card>
  )
}

function PaceTooltip({
  active, payload, label,
}: {
  active?: boolean
  payload?: { name: string; value: number; color: string; dataKey: string }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-xs shadow-elev tabular-nums">
      <div className="text-muted mb-1">{label && fmtDateShort(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{p.name}:</span>
          <span className="text-text font-medium">
            {p.value == null ? '—' : p.value.toFixed(2)}
          </span>
        </div>
      ))}
    </div>
  )
}

// =====================================================================
// Strength tracker — weekly session count + total load
// =====================================================================

const STRENGTH_RANGES = [
  { label: '1y', weeks: 52 },
  { label: '2y', weeks: 104 },
  { label: '5y', weeks: 260 },
] as const

function StrengthTrackerPanel() {
  const [weeks, setWeeks] = useState<number>(104)
  const [resp, setResp] = useState<{
    values: StrengthVolumeWeek[]
    last_session_date: string | null
    total_sessions: number
  } | null>(null)

  useEffect(() => {
    setResp(null)
    api.strengthVolume(weeks).then((r) => setResp({
      values: r.values,
      last_session_date: r.last_session_date,
      total_sessions: r.total_sessions,
    }))
  }, [weeks])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <CardTitle>Strength volume</CardTitle>
            <p className="text-[11px] text-faint mt-1">
              Weekly count of strength-tagged sessions. Instinct Solar doesn't
              record sets/reps/weight, so this tracks frequency + duration only.
            </p>
          </div>
          <RangeToggle
            options={STRENGTH_RANGES.map((r) => ({ label: r.label, value: r.weeks }))}
            value={weeks}
            onChange={setWeeks}
          />
        </div>
      </CardHeader>
      <CardBody>
        {resp == null ? (
          <ChartLoading />
        ) : resp.total_sessions === 0 ? (
          <EmptyState>
            No strength sessions recorded in this window. Log them on your
            watch as a "Strength" activity to start populating this view.
          </EmptyState>
        ) : (
          <>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={resp.values} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="week_start"
                    tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                    tickFormatter={fmtDateShort}
                    axisLine={{ stroke: 'var(--color-border)' }}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis
                    tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                    allowDecimals={false}
                  />
                  <Tooltip content={<StrengthTooltip />} />
                  <Bar
                    dataKey="sessions"
                    fill="oklch(0.65 0.16 280)"
                    radius={[3, 3, 0, 0]}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-between text-xs text-muted mt-3 tabular-nums">
              <div>{resp.total_sessions} session{resp.total_sessions === 1 ? '' : 's'} total</div>
              <div>
                Last: {resp.last_session_date ? fmtDate(resp.last_session_date) : '—'}
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  )
}

function StrengthTooltip({
  active, payload, label,
}: {
  active?: boolean
  payload?: { payload: StrengthVolumeWeek }[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const w = payload[0].payload
  return (
    <div className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-xs shadow-elev tabular-nums">
      <div className="text-muted mb-1">Week of {label && fmtDateShort(label)}</div>
      <div className="flex items-center gap-2">
        <span className="text-muted">sessions:</span>
        <span className="text-text font-medium">{w.sessions}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted">duration:</span>
        <span className="text-text font-medium">{w.total_duration_min.toFixed(0)} min</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted">calories:</span>
        <span className="text-text font-medium">{w.total_calories}</span>
      </div>
    </div>
  )
}

// =====================================================================
// Shared bits
// =====================================================================

function RangeToggle<T extends number>({
  options, value, onChange,
}: {
  options: { label: string; value: T }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex bg-surface border border-border rounded-full p-0.5 text-xs">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={
            'px-3 py-1.5 rounded-full transition-colors ' +
            (value === opt.value
              ? 'bg-accent text-bg'
              : 'text-muted hover:text-text')
          }
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function ChartLoading() {
  return (
    <div className="h-64 flex items-center justify-center">
      <Loader2 className="size-4 text-muted animate-spin" />
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-40 flex items-center justify-center text-sm text-muted text-center px-6">
      {children}
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

