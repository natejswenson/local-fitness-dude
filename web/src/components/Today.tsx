import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import type { TodayResponse, Workout } from '@/lib/types'
import { Card, CardBody, CardTitle } from './Card'
import { ChatPanel } from './ChatPanel'
import { StatCard } from './StatCard'
import { deltaText, fmtKm, fmtPace, fmtSeconds } from '@/lib/utils'

export function Today() {
  const [data, setData] = useState<TodayResponse | null>(null)
  const [workouts, setWorkouts] = useState<Workout[] | null>(null)
  const [brief, setBrief] = useState<string | null>(null)
  const [briefLoading, setBriefLoading] = useState(false)
  const [showWorkouts, setShowWorkouts] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.today(), api.workouts({ days: 30, limit: 8 }), api.brief()])
      .then(([t, w, b]) => {
        setData(t)
        setWorkouts(w.workouts)
        setBrief(b.markdown)
      })
      .catch((e) => setError(String(e)))
  }, [])

  async function regenerateBrief() {
    setBriefLoading(true)
    try {
      const b = await api.briefGenerate('claude-sonnet-4-6')
      setBrief(b.markdown)
    } catch (e) {
      setError(String(e))
    } finally {
      setBriefLoading(false)
    }
  }

  if (error) return <div className="p-6 text-bad">{error}</div>
  if (!data) return <Loading />

  const today = new Date(data.today + 'T00:00:00')
  const greeting = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const recent = [...data.recent_14d].reverse()
  const bbSpark = recent.filter((d) => d.body_battery_max != null).map((d) => ({ date: d.date, value: d.body_battery_max! }))
  const rhrSpark = recent.filter((d) => d.rhr != null).map((d) => ({ date: d.date, value: d.rhr! }))
  const sleepSpark = recent.filter((d) => d.sleep_seconds != null).map((d) => ({ date: d.date, value: d.sleep_seconds! / 3600 }))

  const latest = data.latest
  const baseline = data.baseline
  const bbDelta = deltaText(latest?.body_battery_max ?? null, baseline?.body_battery_max_60day_mean ?? null)
  const rhrDelta = deltaText(latest?.rhr ?? null, baseline?.rhr_60day_mean ?? null, { invertGood: true })
  const sleepDelta = deltaText(
    latest?.sleep_seconds ? latest.sleep_seconds / 3600 : null,
    baseline?.sleep_seconds_60day_mean ? baseline.sleep_seconds_60day_mean / 3600 : null,
  )
  const tsb = baseline?.tsb ?? null
  const tsbTone: 'good' | 'bad' | 'neutral' =
    tsb == null ? 'neutral' : tsb > 5 ? 'good' : tsb < -10 ? 'bad' : 'neutral'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <div>
          <div className="text-sm text-muted">{greeting}</div>
          <h1 className="text-2xl font-semibold tracking-tight mt-0.5">Today</h1>
        </div>

        {/* Brief — the focal point */}
        <Card>
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <CardTitle>Morning Brief</CardTitle>
            <button
              onClick={regenerateBrief}
              disabled={briefLoading}
              className="text-xs text-muted hover:text-text inline-flex items-center gap-1.5 px-2 py-1 rounded"
              title="Regenerate brief"
            >
              {briefLoading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {brief ? 'Regenerate' : 'Generate'}
            </button>
          </div>
          <div className="px-6 pb-6">
            {brief ? (
              <div className="prose-fitness text-[15px]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{brief}</ReactMarkdown>
              </div>
            ) : (
              <div className="text-sm text-muted py-4">
                No brief yet for today. Click Generate.
              </div>
            )}
          </div>
        </Card>

        {/* Stat cards — at-a-glance under the brief */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Body Battery"
            value={latest?.body_battery_max?.toString() ?? '—'}
            delta={bbDelta.text}
            deltaTone={bbDelta.tone}
            sub="vs 60d baseline"
            sparkline={bbSpark}
          />
          <StatCard
            label="Resting HR"
            value={latest?.rhr?.toString() ?? '—'}
            unit="bpm"
            delta={rhrDelta.text}
            deltaTone={rhrDelta.tone}
            sub="vs 60d baseline"
            sparkline={rhrSpark}
          />
          <StatCard
            label="Sleep"
            value={latest?.sleep_seconds ? fmtSeconds(latest.sleep_seconds) : '—'}
            delta={sleepDelta.text}
            deltaTone={sleepDelta.tone}
            sub={`score ${latest?.sleep_score ?? '—'}`}
            sparkline={sleepSpark}
          />
          <StatCard
            label="Form (TSB)"
            value={tsb != null ? tsb.toFixed(1) : '—'}
            deltaTone={tsbTone}
            delta={
              tsb == null ? undefined :
              tsb > 5 ? 'fresh' :
              tsb < -20 ? 'very fatigued' :
              tsb < -10 ? 'fatigued' :
              'neutral'
            }
            sub={baseline ? `CTL ${baseline.ctl?.toFixed(0)} · ATL ${baseline.atl?.toFixed(0)}` : undefined}
          />
        </div>

        {/* Subtle divider before the conversation */}
        <div className="border-t border-border my-2" />

        {/* Embedded chat — composer + suggestions when empty, conversation when active */}
        <ChatPanel />

        {/* Recent workouts — collapsed by default to keep the brief + chat as the focus */}
        <div>
          <button
            onClick={() => setShowWorkouts((v) => !v)}
            className="w-full flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted hover:text-text transition-colors py-2"
          >
            <span className="inline-flex items-center gap-2">
              {showWorkouts ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              Recent Workouts
              {workouts && <span className="text-faint normal-case tracking-normal">({workouts.length})</span>}
            </span>
          </button>
          {showWorkouts && workouts && workouts.length > 0 && (
            <Card className="mt-2">
              <CardBody>
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted">
                      <tr className="text-left">
                        <th className="font-medium pb-2 pr-4">Date</th>
                        <th className="font-medium pb-2 pr-4">Type</th>
                        <th className="font-medium pb-2 pr-4 text-right">Distance</th>
                        <th className="font-medium pb-2 pr-4 text-right">Duration</th>
                        <th className="font-medium pb-2 pr-4 text-right">Pace</th>
                        <th className="font-medium pb-2 pr-4 text-right">HR</th>
                        <th className="font-medium pb-2 text-right">Load</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {workouts.map((w) => (
                        <tr key={w.activity_id} className="border-t border-border">
                          <td className="py-2 pr-4">{new Date(w.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                          <td className="py-2 pr-4 text-muted capitalize">{w.activity_type.replace(/_/g, ' ')}</td>
                          <td className="py-2 pr-4 text-right">{fmtKm(w.distance_meters)}</td>
                          <td className="py-2 pr-4 text-right">{fmtSeconds(w.duration_seconds)}</td>
                          <td className="py-2 pr-4 text-right text-muted">{fmtPace(w.avg_pace_sec_per_km)}</td>
                          <td className="py-2 pr-4 text-right">{w.avg_hr ?? '—'}</td>
                          <td className="py-2 text-right text-accent">{w.training_load?.toFixed(0) ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loader2 className="size-5 text-muted animate-spin" />
    </div>
  )
}
