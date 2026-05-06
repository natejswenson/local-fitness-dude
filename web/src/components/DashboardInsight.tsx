import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Loader2, MessageSquare, RotateCw, Wrench, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ChatEvent } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Dashboard-embedded conversation. Lives directly under each chart so
 * the answer streams in the same visual context as the data that
 * prompted it — no scroll, no separate page-level chat panel, no
 * textarea-edit step before firing.
 *
 * UX:
 *   1. Resting state: a row of context-aware question chips.
 *   2. Click a chip → AUTO-FIRES the prompt (skipping the edit step
 *      that previously made the flow feel clunky). Tool pills surface
 *      what the agent is fetching; a markdown answer streams in.
 *   3. After the answer, a follow-up composer appears with the chips
 *      still accessible above for one-click pivots.
 *   4. ✕ collapses back to the resting state without losing the
 *      conversation server-side (closes nothing) — clicking another
 *      chip starts fresh.
 *
 * Sessions are SHARED across the three dashboard panels via the
 * `sessionId` prop, so context carries when the user moves from
 * heatmap → pace efficiency → strength.
 */

type ToolCall = { name: string; input: Record<string, unknown> }
type Message =
  | { role: 'user'; text: string; id: string }
  | { role: 'assistant'; text: string; tools: ToolCall[]; id: string; pending?: boolean }

const newId = () => Math.random().toString(36).slice(2, 10)

export type Prompt = { label: string; seed: string }

export function DashboardInsight({
  prompts,
  sessionId,
  model,
  topic,
}: {
  prompts: Prompt[]
  sessionId: string
  model: 'sonnet' | 'opus'
  /** Short label rendered next to the chip row, e.g. "About the heatmap". */
  topic: string
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const conversationRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // When a new assistant chunk arrives, scroll the bottom of the
  // conversation block into view smoothly — but only if it's already
  // partially below the fold. This keeps the chart visible while the
  // answer streams instead of yanking the page.
  useEffect(() => {
    if (messages.length === 0) return
    conversationRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [messages])

  async function send(text: string) {
    const trimmed = text.trim()
    if (!trimmed || streaming) return

    const modelId = model === 'opus' ? 'claude-opus-4-7' : 'claude-sonnet-4-6'
    const userMsg: Message = { role: 'user', text: trimmed, id: newId() }
    const assistantMsg: Message = {
      role: 'assistant', text: '', tools: [], id: newId(), pending: true,
    }
    setMessages((m) => [...m, userMsg, assistantMsg])
    setInput('')
    setStreaming(true)
    abortRef.current = new AbortController()

    try {
      for await (const ev of api.chat(sessionId, trimmed, modelId, abortRef.current.signal)) {
        applyEvent(assistantMsg.id, ev)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      applyEvent(assistantMsg.id, { type: 'error', message: msg })
    } finally {
      setMessages((m) => m.map((x) => (x.id === assistantMsg.id ? { ...x, pending: false } as Message : x)))
      setStreaming(false)
      abortRef.current = null
    }
  }

  function applyEvent(assistantId: string, ev: ChatEvent) {
    setMessages((m) =>
      m.map((msg) => {
        if (msg.id !== assistantId || msg.role !== 'assistant') return msg
        if (ev.type === 'text') return { ...msg, text: msg.text + ev.text }
        if (ev.type === 'tool_use') return { ...msg, tools: [...msg.tools, { name: ev.name, input: ev.input }] }
        if (ev.type === 'error') return { ...msg, text: (msg.text ? msg.text + '\n\n' : '') + `⚠ ${ev.message}` }
        return msg
      }),
    )
  }

  function clear() {
    abortRef.current?.abort()
    setMessages([])
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(input)
    }
  }

  const hasConversation = messages.length > 0

  return (
    <div className="mt-4 pt-4 border-t border-border/60">
      {/* Header — chip row OR a "more questions" row + clear button */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted shrink-0 pt-1">
          <MessageSquare className="size-3 text-accent" />
          {hasConversation ? `Insights · ${topic}` : `Ask the agent · ${topic}`}
        </div>
        <div className="flex flex-wrap gap-2 flex-1">
          {prompts.map((p) => {
            const isCurrent = streaming && messages[messages.length - 2]?.role === 'user'
              && (messages[messages.length - 2] as { text: string }).text === p.seed
            return (
              <button
                key={p.label}
                onClick={() => send(p.seed)}
                disabled={streaming}
                className={cn(
                  'text-[12px] px-2.5 py-1 rounded-full border transition-colors',
                  isCurrent
                    ? 'border-accent-dim bg-accent/10 text-accent'
                    : 'border-border text-muted hover:text-text hover:border-accent-dim hover:bg-surface',
                  streaming && 'opacity-60 cursor-not-allowed',
                )}
              >
                {p.label}
              </button>
            )
          })}
        </div>
        {hasConversation && (
          <button
            onClick={clear}
            className="text-[11px] text-muted hover:text-text inline-flex items-center gap-1 px-2 py-1 rounded-full border border-border hover:bg-surface transition-colors shrink-0"
            title="Dismiss this conversation"
          >
            <X className="size-3" />
            Clear
          </button>
        )}
      </div>

      {/* Conversation — only rendered once the user has fired something */}
      {hasConversation && (
        <div ref={conversationRef} className="mt-4 space-y-4">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} streaming={streaming} />
          ))}

          {/* Follow-up composer — appears once a question has been fired
              so the user can drill in without leaving the chart. */}
          <form
            onSubmit={(e) => { e.preventDefault(); send(input) }}
            className="flex items-end gap-2 bg-surface border border-border rounded-2xl px-3 py-2 focus-within:border-accent-dim transition-colors"
          >
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Ask a follow-up about this view…"
              rows={1}
              className="flex-1 bg-transparent resize-none outline-none placeholder:text-faint text-[14px] leading-relaxed max-h-32"
              disabled={streaming}
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className={cn(
                'size-7 shrink-0 rounded-full flex items-center justify-center transition-colors',
                input.trim() && !streaming
                  ? 'bg-accent text-bg hover:opacity-90'
                  : 'bg-surface-2 text-faint cursor-not-allowed',
              )}
            >
              {streaming ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="flex">
        <div className="text-[13px] text-muted italic border-l-2 border-accent-dim/50 pl-3 py-0.5">
          {message.text}
        </div>
      </div>
    )
  }
  const isPending = message.pending && streaming
  return (
    <div>
      {message.tools.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {message.tools.map((t, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border text-muted bg-surface border-border"
              title={JSON.stringify(t.input)}
            >
              <Wrench className="size-3" />
              {t.name.replace(/^mcp__fitness__/, '')}
            </span>
          ))}
        </div>
      )}
      <div className="prose-fitness text-[14px]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text || ''}</ReactMarkdown>
        {isPending && !message.text && (
          <div className="text-muted text-[13px] flex items-center gap-2">
            <RotateCw className="size-3 animate-spin" />
            Reading your data…
          </div>
        )}
        {isPending && message.text && (
          <span className="inline-block size-1.5 rounded-full bg-accent ml-0.5 animate-pulse" />
        )}
      </div>
    </div>
  )
}
