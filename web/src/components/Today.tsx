import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import type { Brief, Workout } from '@/lib/types'
import { Card, CardBody } from './Card'
import { ChatPanel } from './ChatPanel'
import { SyncIndicator } from './SyncIndicator'
import { TakeawayCard } from './TakeawayCard'
import { fmtKm, fmtPace, fmtSeconds } from '@/lib/utils'

export function Today() {
  const [brief, setBrief] = useState<Brief | null>(null)
  const [workouts, setWorkouts] = useState<Workout[] | null>(null)
  const [briefLoading, setBriefLoading] = useState(false)
  const [showWorkouts, setShowWorkouts] = useState(false)
  const [userName, setUserName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.brief(), api.workouts({ days: 30, limit: 8 }), api.config()])
      .then(([b, w, c]) => {
        setBrief(b.brief)
        setWorkouts(w.workouts)
        setUserName(c.user_name)
      })
      .catch((e) => setError(String(e)))
  }, [])

  // Triggered by SyncIndicator when a background pull just completed
  // successfully — quietly refetch workouts so any newly-arrived data shows.
  function onSyncCompleted() {
    api.workouts({ days: 30, limit: 8 }).then((w) => setWorkouts(w.workouts)).catch(() => {})
  }

  async function regenerateBrief() {
    setBriefLoading(true)
    try {
      const r = await api.briefGenerate('claude-sonnet-4-6')
      setBrief(r.brief)
    } catch (e) {
      setError(String(e))
    } finally {
      setBriefLoading(false)
    }
  }

  if (error) return <div className="p-6 text-bad">{error}</div>

  const today = new Date()
  const greeting = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">
        {/* Header — personalised greeting + sync status + regenerate */}
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-sm text-muted">{greeting}</div>
            <h1 className="text-2xl font-semibold tracking-tight mt-0.5">
              {userName ? `${timeOfDayGreeting()}, ${userName}` : 'Today'}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <SyncIndicator onCompleted={onSyncCompleted} />
            <button
              onClick={regenerateBrief}
              disabled={briefLoading}
              className="text-xs text-muted hover:text-text inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-surface hover:bg-surface-2 transition-colors"
              title="Regenerate brief"
            >
              {briefLoading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              {brief ? 'Regenerate brief' : 'Generate brief'}
            </button>
          </div>
        </div>

        {/* Key Takeaways */}
        {brief ? (
          <div className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-wider text-muted">
              Key Takeaways
            </div>
            {brief.takeaways.map((t, i) => (
              <TakeawayCard key={i} takeaway={t} />
            ))}
          </div>
        ) : (
          <Card>
            <div className="p-8 text-center">
              <div className="text-sm text-muted">
                No brief yet for today. Click "Generate brief" above.
              </div>
            </div>
          </Card>
        )}

        {/* Subtle divider before the conversation */}
        <div className="border-t border-border my-2" />

        {/* Embedded chat */}
        <ChatPanel />

        {/* Recent workouts — collapsed by default */}
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

function timeOfDayGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}
