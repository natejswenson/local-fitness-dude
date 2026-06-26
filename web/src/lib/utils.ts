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

const METERS_PER_MILE = 1609.344

/** Nate runs in miles — convert at the display edge only (storage stays metric). */
export function toMiles(meters: number | null | undefined): number | null {
  if (meters == null) return null
  return meters / METERS_PER_MILE
}

export function fmtMiles(meters: number | null | undefined, digits = 1): string {
  if (meters == null) return '—'
  return `${(meters / METERS_PER_MILE).toFixed(digits)} mi`
}

/** Pace in min/mile from a sec-per-km value. */
export function fmtPaceMi(secPerKm: number | null | undefined): string {
  if (secPerKm == null) return '—'
  const secPerMile = secPerKm * (METERS_PER_MILE / 1000)
  const m = Math.floor(secPerMile / 60)
  const s = Math.round(secPerMile % 60)
  return `${m}:${s.toString().padStart(2, '0')}/mi`
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Format a plain `YYYY-MM-DD` calendar date in LOCAL time. `new Date('2026-06-16')`
 * parses as UTC midnight, which renders as the previous day in negative-offset
 * timezones — use this for discrete plan dates so they don't shift by a day.
 */
export function fmtDayLocal(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
