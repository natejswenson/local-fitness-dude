import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Loader2, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { SyncState } from '@/lib/types'
import { cn } from '@/lib/utils'

const POLL_INTERVAL_MS = 3_000

type Props = {
  // Called once after a sync run completes successfully (so the parent can refetch).
  onCompleted?: () => void
}

export function SyncIndicator({ onCompleted }: Props) {
  const [state, setState] = useState<SyncState | null>(null)
  const wasRunningRef = useRef(false)
  const lastCompletedRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function poll() {
      try {
        const s = await api.syncStatus()
        if (cancelled) return
        setState(s)

        // Detect a transition from running → done, or a fresh completion.
        const justFinished = wasRunningRef.current && !s.is_running
        const newCompletion = s.last_completed_at && s.last_completed_at !== lastCompletedRef.current
        if ((justFinished || (newCompletion && lastCompletedRef.current != null)) && s.last_status === 'success') {
          onCompleted?.()
        }
        wasRunningRef.current = s.is_running
        lastCompletedRef.current = s.last_completed_at

        // Poll fast while running, slow otherwise.
        timer = window.setTimeout(poll, s.is_running ? 1500 : POLL_INTERVAL_MS)
      } catch {
        timer = window.setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    // Kick off a sync attempt + start polling.
    api.syncStart().catch(() => {})
    poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [onCompleted])

  if (!state) return null

  if (state.is_running) {
    return (
      <Pill tone="info">
        <Loader2 className="size-3 animate-spin" />
        Syncing latest data…
      </Pill>
    )
  }

  if (state.last_status === 'not_configured') {
    return (
      <Pill tone="warn" title="Run `fitness setup` in your terminal to wire up Garmin">
        <Settings2 className="size-3" />
        Sync needs setup
      </Pill>
    )
  }

  if (state.last_status === 'auth_failure') {
    return (
      <Pill tone="bad" title={state.last_error ?? undefined}>
        <AlertTriangle className="size-3" />
        Garmin auth failed
      </Pill>
    )
  }

  if (state.last_status === 'failure' || state.last_status === 'partial') {
    return (
      <Pill tone="bad" title={state.last_error ?? undefined}>
        <AlertTriangle className="size-3" />
        Sync failed
      </Pill>
    )
  }

  if (state.last_completed_at) {
    return (
      <Pill tone="muted" title={syncTooltip(state)}>
        <Check className="size-3" />
        Synced {relativeTime(state.last_completed_at)}
      </Pill>
    )
  }

  return null
}

function syncTooltip(state: SyncState): string {
  const parts: string[] = []
  if (state.last_completed_at) parts.push(`Last: ${new Date(state.last_completed_at).toLocaleString()}`)
  if (state.last_date_fetched) parts.push(`Through: ${state.last_date_fetched}`)
  return parts.join(' · ')
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function Pill({
  children, tone, title,
}: {
  children: React.ReactNode
  tone: 'info' | 'warn' | 'bad' | 'muted'
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border',
        tone === 'info' && 'border-accent-dim text-accent bg-accent/10',
        tone === 'warn' && 'border-warn/40 text-warn bg-warn/10',
        tone === 'bad' && 'border-bad/40 text-bad bg-bad/10',
        tone === 'muted' && 'border-border text-muted bg-surface',
      )}
    >
      {children}
    </span>
  )
}
