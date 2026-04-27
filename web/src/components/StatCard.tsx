import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { Card } from './Card'
import { cn } from '@/lib/utils'

type Tone = 'good' | 'bad' | 'neutral'

export function StatCard({
  label,
  value,
  unit,
  delta,
  deltaTone = 'neutral',
  sparkline,
  sub,
}: {
  label: string
  value: string
  unit?: string
  delta?: string
  deltaTone?: Tone
  sparkline?: { date: string; value: number }[]
  sub?: string
}) {
  const toneClass = {
    good: 'text-good',
    bad: 'text-bad',
    neutral: 'text-muted',
  }[deltaTone]

  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-4 pb-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted">{label}</div>
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">{value}</span>
          {unit && <span className="text-sm text-muted">{unit}</span>}
        </div>
        {(delta || sub) && (
          <div className="mt-1 flex items-center gap-2 text-xs">
            {delta && <span className={cn('tabular-nums', toneClass)}>{delta}</span>}
            {sub && <span className="text-faint">{sub}</span>}
          </div>
        )}
      </div>
      {sparkline && sparkline.length > 1 && (
        <div className="h-12 -mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkline} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`spark-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--color-accent)"
                strokeWidth={1.5}
                fill={`url(#spark-${label})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}
