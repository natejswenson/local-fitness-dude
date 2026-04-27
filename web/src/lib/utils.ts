import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function fmtPace(secPerKm: number | null | undefined): string {
  if (secPerKm == null) return '—'
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${s.toString().padStart(2, '0')}/km`
}

export function fmtKm(meters: number | null | undefined): string {
  if (meters == null) return '—'
  return `${(meters / 1000).toFixed(2)} km`
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function deltaText(value: number | null, baseline: number | null, opts: { invertGood?: boolean } = {}): {
  text: string
  tone: 'good' | 'bad' | 'neutral'
} {
  if (value == null || baseline == null) return { text: '—', tone: 'neutral' }
  const delta = value - baseline
  const pct = Math.abs(delta / baseline) * 100
  if (Math.abs(delta) < 1e-6) return { text: 'at baseline', tone: 'neutral' }
  const sign = delta > 0 ? '+' : ''
  const text = `${sign}${delta.toFixed(delta > 10 || delta < -10 ? 0 : 1)} (${pct.toFixed(0)}%)`
  // For RHR, higher than baseline is BAD. For sleep, lower is BAD.
  const isAbove = delta > 0
  let tone: 'good' | 'bad' | 'neutral' = 'neutral'
  if (opts.invertGood) tone = isAbove ? 'bad' : 'good'
  else tone = isAbove ? 'good' : 'bad'
  return { text, tone }
}
