import { useEffect, useMemo, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, CardBody, CardHeader, CardTitle } from './Card'
import { cn, fmtDateShort } from '@/lib/utils'

const RANGES = [
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: '6mo', days: 180 },
  { label: '1y', days: 365 },
  { label: '2y', days: 730 },
  { label: 'All', days: 2000 },
] as const

const METRICS = [
  { key: 'rhr', label: 'Resting HR', unit: 'bpm', color: 'oklch(0.78 0.16 28)', baseline: true },
  { key: 'sleep_seconds', label: 'Sleep', unit: 'h', color: 'oklch(0.72 0.13 250)', baseline: true, transform: (v: number) => v / 3600 },
  { key: 'body_battery_max', label: 'Body Battery (peak)', unit: '', color: 'oklch(0.78 0.16 158)', baseline: false },
  { key: 'avg_stress', label: 'Stress (avg)', unit: '', color: 'oklch(0.78 0.16 65)', baseline: false },
  { key: 'vo2_max', label: 'VO₂ max', unit: '', color: 'oklch(0.75 0.16 295)', baseline: false },
] as const

type MetricKey = (typeof METRICS)[number]['key']

export function Trends() {
  const [days, setDays] = useState<number>(180)
  const [metricKey, setMetricKey] = useState<MetricKey>('rhr')
  const metric = METRICS.find((m) => m.key === metricKey)!

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <header className="flex items-end justify-between">
          <div>
            <div className="text-sm text-muted">Patterns across years</div>
            <h1 className="text-2xl font-semibold tracking-tight mt-0.5">Trends</h1>
          </div>
          <RangeToggle value={days} onChange={setDays} />
        </header>

        <TrainingLoadChart days={days} />

        <Card>
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <CardTitle>{metric.label}</CardTitle>
            <div className="flex flex-wrap gap-1.5">
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setMetricKey(m.key)}
                  className={cn(
                    'text-xs px-2.5 py-1 rounded-full border transition-colors',
                    m.key === metricKey
                      ? 'border-accent-dim bg-surface-2 text-text'
                      : 'border-border text-muted hover:text-text hover:bg-surface',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <CardBody>
            <MetricChart days={days} metricKey={metricKey} />
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function RangeToggle({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex bg-surface border border-border rounded-full p-0.5 text-xs">
      {RANGES.map((r) => (
        <button
          key={r.days}
          onClick={() => onChange(r.days)}
          className={cn(
            'px-3 py-1.5 rounded-full transition-colors',
            value === r.days ? 'bg-accent text-bg' : 'text-muted hover:text-text',
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

function TrainingLoadChart({ days }: { days: number }) {
  const [data, setData] = useState<{ date: string; ctl: number; atl: number; tsb: number }[] | null>(null)
  useEffect(() => {
    setData(null)
    api.trainingLoad(days).then((r) => setData(r.values))
  }, [days])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-end justify-between">
          <CardTitle>Training Load (Banister model)</CardTitle>
          <div className="flex gap-3 text-[11px] text-muted">
            <Legend color="oklch(0.55 0.13 250)" label="CTL (fitness)" />
            <Legend color="oklch(0.65 0.18 28)" label="ATL (fatigue)" />
            <Legend color="oklch(0.78 0.16 158)" label="TSB (form)" />
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <div className="h-72">
          {data == null ? (
            <ChartLoading />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="ctl-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.55 0.13 250)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="oklch(0.55 0.13 250)" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="atl-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.65 0.18 28)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="oklch(0.65 0.18 28)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
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
                  tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <Tooltip content={<ChartTooltip valueFormatter={(v) => v.toFixed(1)} />} />
                <ReferenceLine y={0} stroke="var(--color-border)" />
                <Area dataKey="ctl" stroke="oklch(0.55 0.13 250)" strokeWidth={1.8} fill="url(#ctl-grad)" name="CTL" isAnimationActive={false} />
                <Area dataKey="atl" stroke="oklch(0.65 0.18 28)" strokeWidth={1.8} fill="url(#atl-grad)" name="ATL" isAnimationActive={false} />
                <Line dataKey="tsb" stroke="oklch(0.78 0.16 158)" strokeWidth={1.8} dot={false} name="TSB" type="monotone" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

function MetricChart({ days, metricKey }: { days: number; metricKey: MetricKey }) {
  const metric = METRICS.find((m) => m.key === metricKey)!
  const [series, setSeries] = useState<{ date: string; value: number; baseline?: number | null }[] | null>(null)

  useEffect(() => {
    setSeries(null)
    api.metric(metricKey, days).then((r) => {
      const transform = 'transform' in metric && typeof metric.transform === 'function'
        ? metric.transform
        : (v: number) => v
      const baselineMap = new Map(
        (r.baseline ?? []).map((b) => [b.date, transform(b.value)]),
      )
      setSeries(
        r.values.map((v) => ({
          date: v.date,
          value: transform(v.value),
          baseline: baselineMap.get(v.date) ?? null,
        })),
      )
    })
  }, [days, metricKey, metric])

  const showBaseline = useMemo(
    () => metric.baseline && series?.some((s) => s.baseline != null),
    [metric.baseline, series],
  )

  return (
    <div className="h-80">
      {series == null ? (
        <ChartLoading />
      ) : series.length === 0 ? (
        <div className="h-full flex items-center justify-center text-sm text-muted">
          No data in this window.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
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
              tick={{ fill: 'var(--color-faint)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={36}
              domain={['auto', 'auto']}
            />
            <Tooltip content={<ChartTooltip valueFormatter={(v) => v.toFixed(metric.unit === 'h' ? 1 : 0) + (metric.unit ? ` ${metric.unit}` : '')} />} />
            {showBaseline && (
              <Line
                dataKey="baseline"
                stroke="var(--color-faint)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                name="60d baseline"
                isAnimationActive={false}
              />
            )}
            <Line
              dataKey="value"
              stroke={metric.color}
              strokeWidth={1.8}
              dot={false}
              name={metric.label}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

function ChartLoading() {
  return (
    <div className="h-full flex items-center justify-center">
      <Loader2 className="size-4 text-muted animate-spin" />
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

function ChartTooltip({
  active, payload, label, valueFormatter,
}: {
  active?: boolean
  payload?: { name: string; value: number; color: string }[]
  label?: string
  valueFormatter?: (v: number) => string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-xs shadow-elev">
      <div className="text-muted mb-1">{label && fmtDateShort(label)}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 tabular-nums">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted">{p.name}:</span>
          <span className="text-text font-medium">
            {p.value == null ? '—' : valueFormatter ? valueFormatter(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}
