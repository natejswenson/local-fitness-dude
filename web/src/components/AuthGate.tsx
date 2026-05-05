import { useEffect, useState, type ReactNode } from 'react'
import { api, authToken, onAuthRequired, AuthRequiredError } from '@/lib/api'

/**
 * Bearer-token gate. Shown only when the server enforces auth AND the
 * token in localStorage is missing or rejected. Once a valid token is
 * pasted, the SPA mounts normally and stays mounted across navigations.
 *
 * Flow on first paint:
 *   1. probe `/api/auth/verify` with whatever token is in localStorage.
 *   2. 200 → render children.
 *   3. 401 / AuthRequiredError → render the entry form.
 *   4. submit → re-probe with the freshly-typed token; on 200, persist
 *      it to localStorage and render children.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'authed' | 'needs_token'>('checking')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await api.authVerify()
        if (!cancelled) setState('authed')
      } catch (e) {
        if (e instanceof AuthRequiredError) {
          if (!cancelled) setState('needs_token')
        } else {
          // Network error or 5xx — pessimistically prompt rather than
          // silently leaving the user on a blank page.
          if (!cancelled) setState('needs_token')
        }
      }
    })()
    // Re-prompt mid-session if any later request returns 401 (e.g. the
    // server token rotated). The api wrapper clears localStorage and
    // emits via onAuthRequired before throwing.
    const off = onAuthRequired(() => {
      if (!cancelled) setState('needs_token')
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  if (state === 'checking') {
    return (
      <div className="h-full grid place-items-center bg-bg text-muted text-sm">
        Loading…
      </div>
    )
  }
  if (state === 'needs_token') {
    return <TokenEntry onSuccess={() => setState('authed')} />
  }
  return <>{children}</>
}

function TokenEntry({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!token.trim()) return
    setSubmitting(true)
    setErr(null)
    // Persist BEFORE the probe so authedFetch picks it up; we'll clear
    // again on rejection.
    authToken.set(token.trim())
    try {
      await api.authVerify()
      onSuccess()
    } catch (e) {
      authToken.clear()
      if (e instanceof AuthRequiredError) {
        setErr('Token rejected. Check the value in your .env and try again.')
      } else {
        setErr('Server unreachable. Is `fitness serve` running?')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="h-full grid place-items-center bg-bg p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm flex flex-col gap-3 bg-surface border border-border rounded-2xl p-6 shadow-md"
      >
        <h1 className="text-text text-lg font-medium">local-fitness</h1>
        <p className="text-muted text-sm leading-relaxed">
          This server requires an API token. Paste the value of{' '}
          <code className="text-text">LOCAL_FITNESS_API_TOKEN</code> from your{' '}
          <code className="text-text">.env</code> file.
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste token"
          className="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
        {err && <p className="text-bad text-xs">{err}</p>}
        <button
          type="submit"
          disabled={submitting || !token.trim()}
          className="bg-accent text-bg rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {submitting ? 'Verifying…' : 'Continue'}
        </button>
        <p className="text-faint text-xs leading-relaxed">
          The token is stored in this browser only. Clear it via DevTools →
          Application → Local Storage if you need to switch accounts.
        </p>
      </form>
    </div>
  )
}
