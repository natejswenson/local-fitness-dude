import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Loader2, Sparkles, Wrench, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ChatEvent } from '@/lib/types'
import { cn } from '@/lib/utils'

type ToolCall = { name: string; input: Record<string, unknown> }
type Message =
  | { role: 'user'; text: string; id: string }
  | { role: 'assistant'; text: string; tools: ToolCall[]; id: string; pending?: boolean }

const SUGGESTIONS = [
  'Should I run hard today?',
  'What was my hardest training block in the last year?',
  'How does my sleep affect my next-day RHR?',
  'Compare the last 30 days to the prior 30 days',
]

const newId = () => Math.random().toString(36).slice(2, 10)

export function Chat() {
  const [sessionId] = useState(() => crypto.randomUUID())
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [model, setModel] = useState<'sonnet' | 'opus'>('sonnet')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Close session on unmount so the server can release the SDK client
  useEffect(() => {
    return () => {
      api.chatEnd(sessionId).catch(() => {})
    }
  }, [sessionId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
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

  function clearConversation() {
    abortRef.current?.abort()
    api.chatEnd(sessionId).catch(() => {})
    setMessages([])
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(input)
    }
  }

  return (
    <>
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" />
          <span className="text-sm font-medium">Chat</span>
          <span className="text-xs text-faint ml-2">· grounded in 4 years of your data</span>
        </div>
        <div className="flex items-center gap-2">
          <ModelToggle value={model} onChange={setModel} />
          {messages.length > 0 && (
            <button
              onClick={clearConversation}
              className="text-xs text-muted hover:text-text px-2 py-1 rounded inline-flex items-center gap-1"
              title="Clear conversation"
            >
              <X className="size-3.5" />
              Clear
            </button>
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
          {messages.length === 0 && (
            <EmptyState onPick={(s) => { setInput(s); taRef.current?.focus() }} />
          )}
          {messages.map((m) => <MessageBubble key={m.id} message={m} streaming={streaming} />)}
        </div>
      </div>

      <div className="border-t border-border bg-bg/80 backdrop-blur">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <form
            onSubmit={(e) => { e.preventDefault(); send(input) }}
            className="flex items-end gap-2 bg-surface border border-border rounded-2xl px-4 py-3 focus-within:border-accent-dim transition-colors"
          >
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Ask anything about your training…"
              rows={1}
              className="flex-1 bg-transparent resize-none outline-none placeholder:text-faint text-[15px] leading-relaxed max-h-48"
              autoFocus
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className={cn(
                'size-8 shrink-0 rounded-full flex items-center justify-center transition-colors',
                input.trim() && !streaming
                  ? 'bg-accent text-bg hover:opacity-90'
                  : 'bg-surface-2 text-faint cursor-not-allowed',
              )}
            >
              {streaming ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </button>
          </form>
          <div className="mt-2 text-[11px] text-faint text-center">
            {model === 'opus' ? 'Opus 4.7' : 'Sonnet 4.6'} · enter to send · shift+enter for newline
          </div>
        </div>
      </div>
    </>
  )
}

function EmptyState({ onPick }: { onPick: (s: string) => void }) {
  return (
    <div className="py-16 flex flex-col items-center text-center">
      <div className="size-12 rounded-2xl bg-surface flex items-center justify-center mb-4 shadow-card">
        <Sparkles className="size-5 text-accent" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">Ask your training data anything</h2>
      <p className="text-sm text-muted mt-1.5 max-w-sm">
        Grounded in 4+ years of your Garmin metrics. The agent queries the DB before answering.
      </p>
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-xl">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="text-left text-sm px-4 py-3 bg-surface border border-border rounded-xl hover:border-accent-dim hover:bg-surface-2 transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ message, streaming }: { message: Message; streaming: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-surface border border-border rounded-2xl px-4 py-2.5 text-[15px]">
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
              className="inline-flex items-center gap-1.5 text-[11px] text-muted bg-surface px-2 py-1 rounded-full border border-border"
              title={JSON.stringify(t.input)}
            >
              <Wrench className="size-3" />
              {t.name.replace(/^mcp__fitness__/, '')}
            </span>
          ))}
        </div>
      )}
      <div className="prose-fitness text-[15px]">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text || ''}</ReactMarkdown>
        {isPending && !message.text && (
          <div className="text-muted text-sm flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            Thinking…
          </div>
        )}
        {isPending && message.text && (
          <span className="inline-block size-2 rounded-full bg-accent ml-0.5 animate-pulse" />
        )}
      </div>
    </div>
  )
}

function ModelToggle({ value, onChange }: { value: 'sonnet' | 'opus'; onChange: (v: 'sonnet' | 'opus') => void }) {
  return (
    <div className="flex bg-surface border border-border rounded-full p-0.5 text-xs">
      {(['sonnet', 'opus'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={cn(
            'px-3 py-1 rounded-full transition-colors capitalize',
            value === m ? 'bg-accent text-bg' : 'text-muted hover:text-text',
          )}
        >
          {m === 'sonnet' ? 'Sonnet 4.6' : 'Opus 4.7'}
        </button>
      ))}
    </div>
  )
}
