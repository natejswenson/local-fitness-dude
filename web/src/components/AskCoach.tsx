import { useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * "Ask your coach" call-to-action. The coach lives in an MCP client (Claude
 * Desktop / Code / Mobile), which a web page can't launch directly — so the
 * actionable thing we CAN do is copy a ready-to-paste prompt to the clipboard
 * and tell the user to drop it into Claude. One click, then paste.
 */
export function AskCoach({
  prompt,
  label = 'Ask your coach',
  className,
}: {
  prompt: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      // Clipboard blocked (insecure context / permissions) — degrade quietly;
      // the surrounding copy still tells the user what to ask.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy a prompt to paste into Claude (Desktop / Code / Mobile) connected to your fitness MCP"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-accent-dim bg-accent/10 px-3 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/15 disabled:opacity-60',
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Sparkles className="size-3.5" />}
      {copied ? 'Copied — paste into Claude' : label}
    </button>
  )
}
