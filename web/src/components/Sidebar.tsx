import { NavLink } from 'react-router-dom'
import { Activity, MessageSquare, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

const items = [
  { to: '/', label: 'Chat', icon: MessageSquare, end: true },
  { to: '/today', label: 'Today', icon: Sparkles, end: false },
  { to: '/trends', label: 'Trends', icon: Activity, end: false },
]

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-border bg-bg/60 backdrop-blur flex flex-col">
      <div className="px-5 py-5 flex items-center gap-2">
        <div className="size-7 rounded-md bg-accent flex items-center justify-center">
          <svg viewBox="0 0 32 32" className="size-4 text-bg" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 18l4-8 4 6 4-4 4 6" />
          </svg>
        </div>
        <span className="font-semibold tracking-tight">fitness</span>
      </div>

      <nav className="flex-1 px-2 py-2 space-y-0.5">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-surface text-text shadow-card'
                    : 'text-muted hover:text-text hover:bg-surface/60',
                )
              }
            >
              <Icon className="size-4" />
              {item.label}
            </NavLink>
          )
        })}
      </nav>

      <div className="px-5 py-4 text-[11px] text-faint">
        local · Garmin → Claude
      </div>
    </aside>
  )
}
