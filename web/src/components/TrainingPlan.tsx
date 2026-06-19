import { useCallback, useEffect, useState } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend as RLegend,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Loader2, Target, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { PlanDetail, PlanResponse, PlanWorkout } from '@/lib/types'
import { AskCoach } from './AskCoach'
import { Card, CardBody, CardHeader, CardTitle } from './Card'
import { cn, fmtDateShort, fmtDayLocal, fmtMiles, fmtPaceMi } from '@/lib/utils'

// Paste-ready prompt for the MCP coach. AskCoach copies it to the clipboard;
// the agent drafts the plan via propose_training_plan and it lands here.
const DRAFT_PLAN_PROMPT =
  'Build me a training plan from my recent Garmin data. My goal is a ' +
  '[5K/10K/half/full] on [race date], targeting about [finish time].'

const DIST_HIT = 0.95 // within 5% of target distance counts as hit
const PACE_HIT = 1.05 // within 5% slower than target pace counts as hit

/** A past session missed if it fell short on distance OR was too slow. */
function missedTargets(w: PlanWorkout): boolean {
  if (w.verdict === 'pending' || w.type === 'rest') return false
  if (w.actual_distance_m === 0) return true
  const distMiss = w.target_distance_m != null && w.actual_distance_m < w.target_distance_m * DIST_HIT
  const paceMiss =
    w.target_pace_sec_per_km != null && w.actual_pace_sec_per_km != null &&
    w.actual_pace_sec_per_km > w.target_pace_sec_per_km * PACE_HIT
  return distMiss || paceMiss
}

const GOAL_LABELS: Record<string, string> = {
  '5k': '5K', '10k': '10K', half: 'Half Marathon', full: 'Marathon', custom: 'Custom',
}

function fmtClock(sec: number | null | undefined): string {
  if (sec == null) return '—'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
    : `${m}:${ss.toString().padStart(2, '0')}`
}

function daysUntil(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const target = new Date(y, m - 1, d).getTime()
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((target - now.getTime()) / 86_400_000)
}

export function TrainingPlan() {
  const [data, setData] = useState<PlanResponse | null>(null)
  const [busy, setBusy] = useState(false)

  const refetch = useCallback(() => {
    api.plan().then(setData).catch(() => setData({ active: null, draft: null }))
  }, [])

  useEffect(() => { refetch() }, [refetch])

  const plan = data?.draft ?? data?.active ?? null
  const isDraft = !!data?.draft
  const hasActive = !!data?.active

  async function commit() {
    if (!data?.draft) return
    if (hasActive && !confirm('This will replace your current active plan. Continue?')) return
    setBusy(true)
    try {
      await api.commitPlan(data.draft.plan_id)
      refetch()
    } finally { setBusy(false) }
  }

  async function remove(target: PlanDetail) {
    const what = target.status === 'active' ? 'active plan' : 'draft'
    if (!confirm(`Delete this ${what}? It will be archived.`)) return
    setBusy(true)
    try {
      await api.deletePlan(target.plan_id)
      refetch()
    } finally { setBusy(false) }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-end justify-between">
          <div>
            <div className="text-sm text-muted">Goal-driven training</div>
            <h1 className="text-2xl font-semibold tracking-tight mt-0.5">Training Plan</h1>
          </div>
        </header>

        {data == null ? (
          <ChartLoading />
        ) : plan == null ? (
          <EmptyState />
        ) : (
          <>
            {isDraft && (
              <DraftBanner busy={busy} onCommit={commit} />
            )}
            <GoalHeader plan={plan} onDelete={() => remove(plan)} busy={busy} />
            <PlanCalendarTable workouts={plan.workouts} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <WeeklyMileageChart data={plan.weekly_mileage} />
              <FitnessTrajectoryChart ctl={plan.ctl_series} raceDate={plan.race_date} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function DraftBanner({ busy, onCommit }: { busy: boolean; onCommit: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-accent-dim bg-accent/10 px-5 py-3">
      <div className="text-sm">
        <span className="font-medium text-accent">Draft</span>
        <span className="text-muted"> — review the draft your coach wrote, then commit to start tracking.</span>
      </div>
      <button
        onClick={onCommit}
        disabled={busy}
        className="shrink-0 rounded-lg bg-accent text-bg text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-50"
      >
        {busy ? 'Committing…' : 'Commit Plan'}
      </button>
    </div>
  )
}

function GoalHeader({ plan, onDelete, busy }: { plan: PlanDetail; onDelete: () => void; busy: boolean }) {
  const days = daysUntil(plan.race_date)
  const onTrack =
    plan.predicted_finish_seconds != null && plan.target_time_seconds != null
      ? plan.predicted_finish_seconds <= plan.target_time_seconds
      : null
  return (
    <Card>
      <div className="px-5 pt-4 pb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
            <Target className="size-3.5 text-accent" />
            {GOAL_LABELS[plan.goal_type] ?? plan.goal_type}
            {plan.title && <span className="text-faint normal-case tracking-normal">· {plan.title}</span>}
          </div>
          <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
            {days > 0 ? `${days} days` : days === 0 ? 'Race day' : 'Race passed'}
          </div>
          <div className="mt-0.5 text-sm text-muted">to {fmtDayLocal(plan.race_date)}</div>
        </div>

        <div className="flex items-stretch gap-6">
          <Stat label="Target" value={fmtClock(plan.target_time_seconds)} />
          <Stat
            label="Projected"
            value={fmtClock(plan.predicted_finish_seconds)}
            tone={onTrack == null ? 'neutral' : onTrack ? 'good' : 'bad'}
            sub={onTrack == null ? 'need a recent effort' : onTrack ? 'on track' : 'behind'}
          />
          <Stat
            label="Adherence"
            value={plan.adherence_pct == null ? '—' : `${plan.adherence_pct}%`}
          />
        </div>

        <button
          onClick={onDelete}
          disabled={busy}
          title="Delete plan"
          className="self-start text-muted hover:text-bad p-2 rounded-lg hover:bg-surface-2 disabled:opacity-50"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </Card>
  )
}

function Stat({
  label, value, tone = 'neutral', sub,
}: { label: string; value: string; tone?: 'good' | 'bad' | 'neutral'; sub?: string }) {
  const toneCls = { good: 'text-good', bad: 'text-bad', neutral: 'text-text' }[tone]
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={cn('mt-2 text-2xl font-semibold tabular-nums', toneCls)}>{value}</div>
      {sub && <div className="text-[11px] text-faint mt-0.5">{sub}</div>}
    </div>
  )
}

function PlanCalendarTable({ workouts }: { workouts: PlanWorkout[] }) {
  if (workouts.length === 0) return null
  return (
    <Card>
      <CardHeader><CardTitle>Schedule</CardTitle></CardHeader>
      <CardBody>
        <div className="overflow-x-auto -mx-5 px-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted">
                <th className="font-medium pb-2 pr-3">Date</th>
                <th className="font-medium pb-2 pr-3">Session</th>
                <th className="font-medium pb-2 pr-3 text-right">Target</th>
                <th className="font-medium pb-2 text-right">Actual</th>
              </tr>
            </thead>
            <tbody>
              {workouts.map((w) => {
                const isRest = w.type === 'rest'
                const showActual = w.verdict !== 'pending' && !isRest
                const missed = missedTargets(w)
                return (
                  <tr key={w.workout_id} className="border-t border-border hover:bg-surface/50 align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-muted">{fmtDayLocal(w.date)}</td>
                    <td className="py-2 pr-3">
                      <span className="capitalize font-medium">{w.type}</span>
                      <span className="text-muted"> — {w.description}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap text-muted">
                      <PaceDist dist={w.target_distance_m} pace={w.target_pace_sec_per_km} rest={isRest} />
                    </td>
                    <td className={cn('py-2 text-right tabular-nums whitespace-nowrap',
                      !showActual ? 'text-faint' : missed ? 'text-bad' : 'text-good')}>
                      {isRest ? '—' : !showActual ? 'Scheduled'
                        : <PaceDist dist={w.actual_distance_m} pace={w.actual_pace_sec_per_km} rest={false} />}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}

function PaceDist({ dist, pace, rest }: { dist: number | null; pace: number | null; rest: boolean }) {
  if (rest) return <span className="text-faint">Rest</span>
  if (dist == null && pace == null) return <>—</>
  const parts: string[] = []
  if (dist != null) parts.push(fmtMiles(dist))
  if (pace != null) parts.push(fmtPaceMi(pace))
  return <>{parts.join(' · ')}</>
}

function WeeklyMileageChart({ data }: { data: PlanDetail['weekly_mileage'] }) {
  // Convert the metric rollup (km) to miles at the display edge.
  const miles = data.map((d) => ({
    week: d.week,
    planned_mi: +(d.planned_km * 0.621371).toFixed(1),
    actual_mi: +(d.actual_km * 0.621371).toFixed(1),
  }))
  return (
    <Card>
      <CardHeader>
        <div className="flex items-end justify-between">
          <CardTitle>Weekly mileage</CardTitle>
          <div className="flex gap-3 text-[11px] text-muted">
            <Legend color="oklch(0.55 0.13 250)" label="Planned" />
            <Legend color="oklch(0.78 0.16 158)" label="Actual" />
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={miles} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="week" tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                tickFormatter={(w) => `W${w}`} axisLine={{ stroke: 'var(--color-border)' }} tickLine={false} />
              <YAxis tick={{ fill: 'var(--color-faint)', fontSize: 11 }} axisLine={false} tickLine={false} width={32} unit="mi" />
              <Tooltip content={<PlanTooltip suffix=" mi" />} />
              <RLegend wrapperStyle={{ display: 'none' }} />
              <Bar dataKey="planned_mi" fill="oklch(0.55 0.13 250)" name="Planned" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="actual_mi" fill="oklch(0.78 0.16 158)" name="Actual" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardBody>
    </Card>
  )
}

function FitnessTrajectoryChart({
  ctl, raceDate,
}: { ctl: { date: string; ctl: number }[]; raceDate: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-end justify-between">
          <CardTitle>Fitness trajectory (CTL)</CardTitle>
          <div className="text-[11px] text-muted">vertical line = race day</div>
        </div>
      </CardHeader>
      <CardBody>
        <div className="h-60">
          {ctl.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-faint">
              No fitness history yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={ctl} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="plan-ctl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.55 0.13 250)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="oklch(0.55 0.13 250)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                  tickFormatter={fmtDateShort} axisLine={{ stroke: 'var(--color-border)' }} tickLine={false} minTickGap={50} />
                <YAxis tick={{ fill: 'var(--color-faint)', fontSize: 11 }} axisLine={false} tickLine={false} width={32} />
                <Tooltip content={<PlanTooltip />} />
                <Area dataKey="ctl" stroke="oklch(0.55 0.13 250)" strokeWidth={1.8} fill="url(#plan-ctl)" name="CTL" isAnimationActive={false} />
                <ReferenceLine x={raceDate} stroke="oklch(0.78 0.16 28)" strokeDasharray="4 3"
                  label={{ value: 'Race', position: 'insideTopRight', fill: 'oklch(0.78 0.16 28)', fontSize: 11 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function EmptyState() {
  return (
    <Card>
      <CardBody className="py-12 flex flex-col items-center text-center">
        <div className="size-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4">
          <Target className="size-6 text-accent" />
        </div>
        <h2 className="text-lg font-semibold">No active plan</h2>
        <p className="mt-1 text-sm text-muted max-w-md">
          Your coach drafts plans from Claude (Desktop, Code, or Mobile) pointed
          at your fitness MCP. Ask it for a plan and it'll appear here as a draft
          to review and commit.
        </p>
        <AskCoach
          prompt={DRAFT_PLAN_PROMPT}
          label="Ask your coach to draft a plan"
          className="mt-5"
        />
      </CardBody>
    </Card>
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

function PlanTooltip({
  active, payload, label, suffix = '',
}: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string | number
  suffix?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-xs shadow-elev">
      <div className="text-muted mb-1">
        {typeof label === 'string' && label.includes('-') ? fmtDateShort(label) : `Week ${label}`}
      </div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 tabular-nums">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{p.name}:</span>
          <span className="text-text font-medium">{p.value == null ? '—' : `${p.value}${suffix}`}</span>
        </div>
      ))}
    </div>
  )
}

function ChartLoading() {
  return (
    <div className="h-40 flex items-center justify-center">
      <Loader2 className="size-4 text-muted animate-spin" />
    </div>
  )
}
