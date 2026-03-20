'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import clsx from 'clsx'
import {
  Play,
  Square,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronUp,
  Activity,
  Zap,
  Database,
  Cpu,
  HardDrive,
  GitBranch,
  BarChart3,
  Terminal,
  Send,
  CheckCircle,
  XCircle,
  Clock,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServiceStatus = 'online' | 'offline' | 'unknown' | 'checking'

interface ServiceHealth {
  backend: ServiceStatus
  java: ServiceStatus
  express: ServiceStatus
}

interface LogEntry {
  id: string
  ts: string
  method: string
  endpoint: string
  status: number | null
  latency: number | null
  summary: string
  error?: boolean
}

interface FlowCardState {
  loading: boolean
  response: unknown | null
  status: number | null
  latency: number | null
  expanded: boolean
  error: string | null
}

interface StressState {
  cpu: boolean
  memory: boolean
  db: boolean
  loading: { cpu: boolean; memory: boolean; db: boolean }
}

interface TrafficState {
  running: boolean
  flow: string
  batchSize: number
  interval: number
  sent: number
  success: number
  errors: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8080'

const FLOW_OPTIONS = [
  { value: '1', label: 'Flow 1 — Correct Path' },
  { value: '2', label: 'Flow 2 — DB Not Found' },
  { value: '3s', label: 'Flow 3 — Compute Success' },
  { value: '3t', label: 'Flow 3 — Compute Timeout' },
  { value: '4', label: 'Flow 4 — Create Item' },
  { value: 'cascade', label: 'Flow — Cascade' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return Math.random().toString(36).slice(2, 9)
}

function formatTimestamp(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

function statusColor(status: number | null): string {
  if (status === null) return 'text-text-secondary'
  if (status >= 200 && status < 300) return 'text-dd-green'
  if (status >= 400 && status < 500) return 'text-dd-amber'
  return 'text-dd-red'
}

function statusBg(status: number | null): string {
  if (status === null) return 'bg-border'
  if (status >= 200 && status < 300) return 'bg-dd-green/20 text-dd-green'
  if (status >= 400 && status < 500) return 'bg-dd-amber/20 text-dd-amber'
  return 'bg-dd-red/20 text-dd-red'
}

function serviceStatusColor(s: ServiceStatus): string {
  switch (s) {
    case 'online': return 'bg-dd-green animate-pulse-green'
    case 'offline': return 'bg-dd-red animate-pulse-red'
    case 'checking': return 'bg-dd-amber animate-pulse'
    default: return 'bg-text-secondary'
  }
}

function truncateJson(obj: unknown, maxLen = 120): string {
  try {
    const s = JSON.stringify(obj)
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  } catch {
    return String(obj)
  }
}

function syntaxHighlight(json: string): string {
  const escaped = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = 'json-number'
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-string'
      } else if (/true|false/.test(match)) {
        cls = 'json-boolean'
      } else if (/null/.test(match)) {
        cls = 'json-null'
      }
      return `<span class="${cls}">${match}</span>`
    }
  )
}

// ---------------------------------------------------------------------------
// Dog SVG Logo
// ---------------------------------------------------------------------------

function DogLogo({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="GridDog logo"
    >
      {/* Body */}
      <ellipse cx="32" cy="38" rx="16" ry="12" fill="#7B4FFF" opacity="0.9" />
      {/* Head */}
      <circle cx="32" cy="22" r="11" fill="#9D78FF" />
      {/* Left ear */}
      <ellipse cx="22" cy="16" rx="5" ry="7" fill="#7B4FFF" transform="rotate(-15 22 16)" />
      {/* Right ear */}
      <ellipse cx="42" cy="16" rx="5" ry="7" fill="#7B4FFF" transform="rotate(15 42 16)" />
      {/* Left eye */}
      <circle cx="27" cy="21" r="2.5" fill="#0F1117" />
      <circle cx="27.8" cy="20.2" r="0.8" fill="white" />
      {/* Right eye */}
      <circle cx="37" cy="21" r="2.5" fill="#0F1117" />
      <circle cx="37.8" cy="20.2" r="0.8" fill="white" />
      {/* Nose */}
      <ellipse cx="32" cy="27" rx="3" ry="2" fill="#5A3BCC" />
      {/* Mouth */}
      <path d="M29 30 Q32 33 35 30" stroke="#5A3BCC" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      {/* Tail */}
      <path d="M48 35 Q56 28 54 38 Q52 44 48 42" stroke="#9D78FF" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* Front left leg */}
      <rect x="22" y="47" width="5" height="10" rx="2.5" fill="#7B4FFF" />
      {/* Front right leg */}
      <rect x="37" y="47" width="5" height="10" rx="2.5" fill="#7B4FFF" />
      {/* Back left leg */}
      <rect x="18" y="44" width="5" height="10" rx="2.5" fill="#6B3FEE" />
      {/* Back right leg */}
      <rect x="41" y="44" width="5" height="10" rx="2.5" fill="#6B3FEE" />
      {/* Collar */}
      <rect x="23" y="30" width="18" height="4" rx="2" fill="#FFAA00" />
      <circle cx="32" cy="32" r="1.5" fill="#FF4B4B" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      style={{ minWidth: size }}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Navbar
// ---------------------------------------------------------------------------

function Navbar({ health, clock }: { health: ServiceHealth; clock: string }) {
  const services: { key: keyof ServiceHealth; label: string }[] = [
    { key: 'backend', label: 'Backend' },
    { key: 'java', label: 'Java' },
    { key: 'express', label: 'Express' },
  ]

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-3"
      style={{
        background: 'rgba(26, 29, 39, 0.95)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid #2A2D3A',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      {/* Left: Logo + Title */}
      <div className="flex items-center gap-3">
        <DogLogo size={40} />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-text-primary tracking-tight">GridDog</span>
            <span
              className="text-xs font-medium px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(123,79,255,0.2)', color: '#9D78FF', border: '1px solid rgba(123,79,255,0.3)' }}
            >
              v0.1.0
            </span>
          </div>
          <div className="text-xs text-text-secondary font-medium tracking-wide">Observability Sandbox</div>
        </div>
      </div>

      {/* Right: Service health + clock */}
      <div className="flex items-center gap-6">
        {/* Service status */}
        <div className="flex items-center gap-4">
          {services.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-1.5">
              <div
                className={clsx('w-2 h-2 rounded-full', serviceStatusColor(health[key]))}
              />
              <span className="text-xs text-text-secondary font-medium">{label}</span>
            </div>
          ))}
        </div>

        {/* Clock */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
          style={{ background: 'rgba(42,45,58,0.6)', border: '1px solid #2A2D3A' }}
        >
          <Clock size={12} className="text-dd-purple" />
          <span className="text-xs font-mono text-text-primary tracking-widest">{clock}</span>
        </div>
      </div>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Method Badge
// ---------------------------------------------------------------------------

function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: 'bg-dd-green/15 text-dd-green border border-dd-green/30',
    POST: 'bg-dd-purple/15 text-dd-purple-light border border-dd-purple/30',
    PUT: 'bg-dd-amber/15 text-dd-amber border border-dd-amber/30',
    DELETE: 'bg-dd-red/15 text-dd-red border border-dd-red/30',
  }
  return (
    <span className={clsx('text-xs font-mono font-semibold px-2 py-0.5 rounded', colors[method] || 'bg-border text-text-secondary')}>
      {method}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Flow Card
// ---------------------------------------------------------------------------

interface FlowCardProps {
  id: string
  title: string
  description: string
  method: string
  endpoint: string
  state: FlowCardState
  onSend: () => void
  onToggleExpand: () => void
}

function FlowCard({ title, description, method, endpoint, state, onSend, onToggleExpand }: FlowCardProps) {
  const { loading, response, status, latency, expanded, error } = state
  const endpointShort = endpoint.replace(BACKEND_URL, '')
  const hasResponse = response !== null || !!error

  return (
    <div
      className="flow-card rounded-lg p-4 flex flex-col gap-3"
      style={{ background: '#1A1D27', border: '1px solid #2A2D3A', boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <MethodBadge method={method} />
            <span className="text-sm font-semibold text-text-primary truncate">{title}</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">{description}</p>
        </div>
      </div>

      {/* Endpoint */}
      <div
        className="text-xs font-mono px-2.5 py-1.5 rounded truncate"
        style={{ background: 'rgba(15,17,23,0.8)', color: '#8B8FA8', border: '1px solid #2A2D3A' }}
        title={endpointShort}
      >
        {endpointShort}
      </div>

      {/* Send button + status */}
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onSend}
          disabled={loading}
          className={clsx(
            'btn-primary flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold',
            loading ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
          )}
          style={{
            background: loading ? '#3A3D4A' : 'linear-gradient(135deg, #7B4FFF, #9D78FF)',
            color: 'white',
          }}
        >
          {loading ? (
            <>
              <Spinner size={12} />
              Sending…
            </>
          ) : (
            <>
              <Send size={12} />
              Send
            </>
          )}
        </button>

        {status !== null && (
          <div className="flex items-center gap-2">
            <span className={clsx('text-xs font-mono font-bold px-2 py-0.5 rounded', statusBg(status))}>
              {status}
            </span>
            {latency !== null && (
              <span className="text-xs text-text-secondary font-mono">{latency}ms</span>
            )}
          </div>
        )}
      </div>

      {/* Expandable response */}
      {hasResponse && (
        <div className="animate-slide-down">
          <button
            onClick={onToggleExpand}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span>{expanded ? 'Hide' : 'Show'} response</span>
          </button>

          {expanded && (
            <div
              className="mt-2 rounded-lg overflow-hidden animate-slide-down"
              style={{ border: '1px solid #2A2D3A' }}
            >
              <div
                className="flex items-center justify-between px-3 py-1.5"
                style={{ background: 'rgba(42,45,58,0.6)', borderBottom: '1px solid #2A2D3A' }}
              >
                <span className="text-xs text-text-secondary font-mono">response</span>
                {status !== null && (
                  <div className="flex items-center gap-1.5">
                    {status >= 200 && status < 300 ? (
                      <CheckCircle size={11} className="text-dd-green" />
                    ) : (
                      <XCircle size={11} className="text-dd-red" />
                    )}
                    <span className={clsx('text-xs font-mono font-semibold', statusColor(status))}>
                      {status}
                    </span>
                    {latency !== null && (
                      <span className="text-xs text-text-secondary font-mono ml-1">{latency}ms</span>
                    )}
                  </div>
                )}
              </div>
              <div
                className="p-3 max-h-48 overflow-y-auto"
                style={{ background: 'rgba(15,17,23,0.95)' }}
              >
                {error ? (
                  <pre className="text-xs text-dd-red font-mono whitespace-pre-wrap break-all">{error}</pre>
                ) : (
                  <pre
                    className="text-xs font-mono whitespace-pre-wrap break-all leading-relaxed"
                    dangerouslySetInnerHTML={{
                      __html: syntaxHighlight(JSON.stringify(response, null, 2)),
                    }}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toggle Switch
// ---------------------------------------------------------------------------

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={clsx(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        checked ? 'bg-dd-red' : 'bg-border'
      )}
      style={{
        boxShadow: checked ? '0 0 12px rgba(255,75,75,0.3)' : 'none',
        transition: 'background-color 0.2s ease, box-shadow 0.2s ease',
      }}
    >
      <span
        className={clsx(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow-lg transition-transform',
          checked ? 'translate-x-6' : 'translate-x-1'
        )}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Stress Card
// ---------------------------------------------------------------------------

interface StressCardProps {
  icon: React.ReactNode
  title: string
  description: string
  active: boolean
  loading: boolean
  onToggle: () => void
}

function StressCard({ icon, title, description, active, loading, onToggle }: StressCardProps) {
  return (
    <div
      className={clsx(
        'rounded-lg p-5 flex flex-col gap-4 transition-all duration-200',
        active && 'shadow-lg'
      )}
      style={{
        background: '#1A1D27',
        border: active ? '1px solid rgba(255,75,75,0.4)' : '1px solid #2A2D3A',
        boxShadow: active ? '0 4px 24px rgba(255,75,75,0.1)' : '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={clsx(
              'p-2 rounded-lg',
              active ? 'text-dd-red' : 'text-text-secondary'
            )}
            style={{
              background: active ? 'rgba(255,75,75,0.15)' : 'rgba(42,45,58,0.5)',
            }}
          >
            {icon}
          </div>
          <div>
            <div className="text-sm font-semibold text-text-primary">{title}</div>
            <div className="text-xs text-text-secondary mt-0.5">{description}</div>
          </div>
        </div>

        {loading ? (
          <Spinner size={20} />
        ) : (
          <ToggleSwitch checked={active} onChange={onToggle} />
        )}
      </div>

      {/* Status indicator */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-lg"
        style={{ background: 'rgba(15,17,23,0.6)', border: '1px solid #2A2D3A' }}
      >
        <div
          className={clsx(
            'w-2 h-2 rounded-full',
            active ? 'bg-dd-red animate-pulse-red' : 'bg-text-secondary'
          )}
        />
        <span
          className={clsx(
            'text-xs font-semibold tracking-wide',
            active ? 'text-dd-red' : 'text-text-secondary'
          )}
        >
          {active ? 'ACTIVE — STRESS RUNNING' : 'IDLE'}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Response Log
// ---------------------------------------------------------------------------

function ResponseLog({
  entries,
  onClear,
}: {
  entries: LogEntry[]
  onClear: () => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        background: '#1A1D27',
        border: '1px solid #2A2D3A',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid #2A2D3A', background: 'rgba(42,45,58,0.4)' }}
      >
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-dd-purple" />
          <span className="text-sm font-semibold text-text-primary">Response Log</span>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-mono"
            style={{ background: 'rgba(123,79,255,0.2)', color: '#9D78FF' }}
          >
            {entries.length}/50
          </span>
        </div>
        <button
          onClick={onClear}
          className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-dd-red transition-colors px-2 py-1 rounded hover:bg-dd-red/10"
        >
          <Trash2 size={12} />
          Clear
        </button>
      </div>

      {/* Log entries */}
      <div className="terminal-panel h-64 overflow-y-auto p-2">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-text-secondary">
            <Terminal size={24} strokeWidth={1} />
            <span className="text-xs">No requests yet. Send a flow to see logs.</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start gap-2 px-2 py-1 rounded hover:bg-white/5 transition-colors group"
            >
              {/* Timestamp */}
              <span className="text-text-secondary shrink-0" style={{ fontSize: 11 }}>
                {entry.ts}
              </span>

              {/* Method */}
              <span
                className="shrink-0 font-semibold"
                style={{
                  fontSize: 10,
                  color: entry.method === 'GET' ? '#00C389' : '#9D78FF',
                  minWidth: 30,
                }}
              >
                {entry.method}
              </span>

              {/* Endpoint */}
              <span
                className="text-text-primary flex-1 truncate"
                style={{ fontSize: 11 }}
                title={entry.endpoint}
              >
                {entry.endpoint.replace(BACKEND_URL, '')}
              </span>

              {/* Status */}
              {entry.status !== null && (
                <span
                  className={clsx('shrink-0 font-bold font-mono', statusColor(entry.status))}
                  style={{ fontSize: 11 }}
                >
                  {entry.status}
                </span>
              )}

              {/* Latency */}
              {entry.latency !== null && (
                <span className="text-text-secondary shrink-0 font-mono" style={{ fontSize: 11 }}>
                  {entry.latency}ms
                </span>
              )}

              {/* Summary */}
              <span
                className={clsx(
                  'shrink-0 truncate max-w-[140px]',
                  entry.error ? 'text-dd-red' : 'text-text-secondary'
                )}
                style={{ fontSize: 10 }}
                title={entry.summary}
              >
                {entry.summary}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Traffic Generator
// ---------------------------------------------------------------------------

interface TrafficGeneratorProps {
  state: TrafficState
  onChange: (patch: Partial<TrafficState>) => void
  onStart: () => void
  onStop: () => void
}

function TrafficGenerator({ state, onChange, onStart, onStop }: TrafficGeneratorProps) {
  const total = state.sent
  const successPct = total > 0 ? Math.round((state.success / total) * 100) : 0
  const errorPct = total > 0 ? Math.round((state.errors / total) * 100) : 0

  return (
    <div
      className="rounded-lg p-5 flex flex-col gap-4"
      style={{
        background: '#1A1D27',
        border: '1px solid #2A2D3A',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      {/* Controls grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Flow selector */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-text-secondary font-medium">Target Flow</label>
          <select
            value={state.flow}
            onChange={(e) => onChange({ flow: e.target.value })}
            disabled={state.running}
            className="rounded-lg px-3 py-2 text-sm text-text-primary font-medium disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-dd-purple"
            style={{
              background: '#0F1117',
              border: '1px solid #2A2D3A',
              WebkitAppearance: 'none',
            }}
          >
            {FLOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* Batch size */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-text-secondary font-medium">
            Batch Size <span className="text-text-secondary">(1–50)</span>
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={state.batchSize}
            onChange={(e) => onChange({ batchSize: Math.min(50, Math.max(1, parseInt(e.target.value) || 1)) })}
            disabled={state.running}
            className="rounded-lg px-3 py-2 text-sm text-text-primary font-mono disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-dd-purple"
            style={{ background: '#0F1117', border: '1px solid #2A2D3A' }}
          />
        </div>

        {/* Interval */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-text-secondary font-medium">
            Interval <span className="text-text-secondary">(ms)</span>
          </label>
          <input
            type="number"
            min={100}
            max={5000}
            step={100}
            value={state.interval}
            onChange={(e) => onChange({ interval: Math.min(5000, Math.max(100, parseInt(e.target.value) || 500)) })}
            disabled={state.running}
            className="rounded-lg px-3 py-2 text-sm text-text-primary font-mono disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-dd-purple"
            style={{ background: '#0F1117', border: '1px solid #2A2D3A' }}
          />
        </div>
      </div>

      {/* Start/Stop + counters */}
      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={state.running ? onStop : onStart}
          className="btn-primary flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold"
          style={{
            background: state.running
              ? 'linear-gradient(135deg, #FF4B4B, #cc3333)'
              : 'linear-gradient(135deg, #7B4FFF, #9D78FF)',
            color: 'white',
          }}
        >
          {state.running ? (
            <>
              <Square size={14} />
              Stop Traffic
            </>
          ) : (
            <>
              <Play size={14} />
              Start Traffic
            </>
          )}
        </button>

        {/* Counters */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Activity size={13} className="text-text-secondary" />
            <span className="text-xs text-text-secondary">Sent:</span>
            <span className="text-xs font-bold font-mono text-text-primary">{state.sent}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <CheckCircle size={13} className="text-dd-green" />
            <span className="text-xs text-text-secondary">OK:</span>
            <span className="text-xs font-bold font-mono text-dd-green">{state.success}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <XCircle size={13} className="text-dd-red" />
            <span className="text-xs text-text-secondary">Err:</span>
            <span className="text-xs font-bold font-mono text-dd-red">{state.errors}</span>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="flex flex-col gap-1.5 animate-fade-in">
          <div className="flex justify-between text-xs text-text-secondary">
            <span>{successPct}% success</span>
            <span>{errorPct}% error</span>
          </div>
          <div className="relative h-2 rounded-full overflow-hidden" style={{ background: '#2A2D3A' }}>
            {/* Success portion */}
            <div
              className="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
              style={{
                width: `${successPct}%`,
                background: 'linear-gradient(90deg, #00C389, #00E5A0)',
              }}
            />
            {/* Error portion */}
            <div
              className="absolute top-0 h-full rounded-full transition-all duration-500"
              style={{
                left: `${successPct}%`,
                width: `${errorPct}%`,
                background: 'linear-gradient(90deg, #FF4B4B, #FF6B6B)',
              }}
            />
            {/* Running shimmer */}
            {state.running && (
              <div
                className="absolute inset-0 opacity-30 progress-shimmer"
                style={{ borderRadius: 9999 }}
              />
            )}
          </div>
        </div>
      )}

      {state.running && (
        <div className="flex items-center gap-2 text-xs text-dd-amber animate-fade-in">
          <div className="w-1.5 h-1.5 rounded-full bg-dd-amber animate-pulse" />
          Traffic generator active — sending every {state.interval}ms
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section Header
// ---------------------------------------------------------------------------

function SectionHeader({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <div
          className="p-2 rounded-lg"
          style={{ background: 'rgba(123,79,255,0.15)', color: '#9D78FF' }}
        >
          {icon}
        </div>
        <div>
          <h2 className="text-base font-bold text-text-primary">{title}</h2>
          {subtitle && <p className="text-xs text-text-secondary mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

const INITIAL_FLOW_STATE: FlowCardState = {
  loading: false,
  response: null,
  status: null,
  latency: null,
  expanded: false,
  error: null,
}

type FlowKey =
  | 'flow1'
  | 'flow2'
  | 'flow3s'
  | 'flow3t'
  | 'flow4'
  | 'cascade'
  | 'items'

interface FlowDefinition {
  title: string
  description: string
  method: 'GET' | 'POST'
  endpoint: string
}

const FLOW_DEFINITIONS: Record<FlowKey, FlowDefinition> = {
  flow1: {
    title: 'Flow 1 — Correct Path',
    description: 'Backend → Java → DB (valid ID). Fetches item with known-good ID.',
    method: 'GET',
    endpoint: `${BACKEND_URL}/api/flow/1`,
  },
  flow2: {
    title: 'Flow 2 — DB Not Found',
    description: 'Backend → Java → DB (invalid ID 9999). Expects 404 error from downstream.',
    method: 'GET',
    endpoint: `${BACKEND_URL}/api/flow/2`,
  },
  flow3s: {
    title: 'Flow 3 — Compute Success',
    description: 'Backend → Express → fibonacci compute. Returns computed result.',
    method: 'GET',
    endpoint: `${BACKEND_URL}/api/flow/3/success`,
  },
  flow3t: {
    title: 'Flow 3 — Compute Timeout',
    description: 'Backend → Express → 15s timeout. Expect gateway timeout error.',
    method: 'GET',
    endpoint: `${BACKEND_URL}/api/flow/3/timeout`,
  },
  flow4: {
    title: 'Flow 4 — Create Item',
    description: 'Backend → Java → DB (insert random item). Returns created entity.',
    method: 'POST',
    endpoint: `${BACKEND_URL}/api/flow/4`,
  },
  cascade: {
    title: 'Flow — Cascade Failure',
    description: 'Java fails → Express skipped → partial response with degraded data.',
    method: 'GET',
    endpoint: `${BACKEND_URL}/api/flow/cascade`,
  },
  items: {
    title: 'Items List',
    description: 'List all DB items via Java service. Paginated response.',
    method: 'GET',
    endpoint: `${BACKEND_URL}/api/items`,
  },
}

export default function Dashboard() {
  // -- Clock
  const [clock, setClock] = useState('')
  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // -- Service health
  const [health, setHealth] = useState<ServiceHealth>({
    backend: 'unknown',
    java: 'unknown',
    express: 'unknown',
  })

  const checkHealth = useCallback(async () => {
    setHealth((h) => ({
      backend: h.backend === 'unknown' ? 'checking' : h.backend,
      java: h.java === 'unknown' ? 'checking' : h.java,
      express: h.express === 'unknown' ? 'checking' : h.express,
    }))
    try {
      const res = await fetch(`${BACKEND_URL}/health`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      setHealth({
        backend: res.ok ? 'online' : 'offline',
        java: data?.services?.java === 'up' ? 'online' : data?.services?.java === 'down' ? 'offline' : res.ok ? 'online' : 'offline',
        express: data?.services?.express === 'up' ? 'online' : data?.services?.express === 'down' ? 'offline' : res.ok ? 'online' : 'offline',
      })
    } catch {
      setHealth({ backend: 'offline', java: 'offline', express: 'offline' })
    }
  }, [])

  useEffect(() => {
    checkHealth()
    const id = setInterval(checkHealth, 10000)
    return () => clearInterval(id)
  }, [checkHealth])

  // -- Response log
  const [log, setLog] = useState<LogEntry[]>([])

  const addLog = useCallback((entry: Omit<LogEntry, 'id' | 'ts'>) => {
    setLog((prev) => {
      const next = [...prev, { ...entry, id: generateId(), ts: formatTimestamp() }]
      return next.slice(-50)
    })
  }, [])

  // -- Generic fetch with logging
  const doFetch = useCallback(
    async (
      url: string,
      method: string,
      options?: RequestInit
    ): Promise<{ data: unknown; status: number; latency: number; error: string | null }> => {
      const start = Date.now()
      try {
        const res = await fetch(url, {
          method,
          headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
          ...options,
          cache: 'no-store',
        })
        const latency = Date.now() - start
        let data: unknown
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('json')) {
          data = await res.json().catch(() => null)
        } else {
          data = await res.text().catch(() => null)
        }
        addLog({
          method,
          endpoint: url,
          status: res.status,
          latency,
          summary: truncateJson(data),
          error: !res.ok,
        })
        return { data, status: res.status, latency, error: null }
      } catch (err) {
        const latency = Date.now() - start
        const msg = err instanceof Error ? err.message : String(err)
        addLog({
          method,
          endpoint: url,
          status: null,
          latency,
          summary: msg,
          error: true,
        })
        return { data: null, status: 0, latency, error: msg }
      }
    },
    [addLog]
  )

  // -- Flow card states
  const [flowStates, setFlowStates] = useState<Record<FlowKey, FlowCardState>>(
    Object.fromEntries(
      Object.keys(FLOW_DEFINITIONS).map((k) => [k, { ...INITIAL_FLOW_STATE }])
    ) as Record<FlowKey, FlowCardState>
  )

  const handleFlowSend = useCallback(
    async (key: FlowKey) => {
      const def = FLOW_DEFINITIONS[key]
      setFlowStates((prev) => ({
        ...prev,
        [key]: { ...prev[key], loading: true, error: null },
      }))

      const { data, status, latency, error } = await doFetch(def.endpoint, def.method)

      setFlowStates((prev) => ({
        ...prev,
        [key]: {
          loading: false,
          response: data,
          status,
          latency,
          expanded: true,
          error,
        },
      }))
    },
    [doFetch]
  )

  const toggleExpanded = useCallback((key: FlowKey) => {
    setFlowStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], expanded: !prev[key].expanded },
    }))
  }, [])

  // -- Stress states
  const [stress, setStress] = useState<StressState>({
    cpu: false,
    memory: false,
    db: false,
    loading: { cpu: false, memory: false, db: false },
  })

  const refreshStressStatus = useCallback(async () => {
    const { data, status } = await doFetch(`${BACKEND_URL}/api/stress/status`, 'GET')
    if (status >= 200 && status < 300 && data && typeof data === 'object') {
      const d = data as Record<string, unknown>
      setStress((prev) => ({
        ...prev,
        cpu: Boolean(d.cpu),
        memory: Boolean(d.memory),
        db: Boolean(d.db),
      }))
    }
  }, [doFetch])

  const toggleStress = useCallback(
    async (type: 'cpu' | 'memory' | 'db') => {
      setStress((prev) => ({
        ...prev,
        loading: { ...prev.loading, [type]: true },
      }))

      const optimisticValue = !stress[type]
      setStress((prev) => ({
        ...prev,
        [type]: optimisticValue,
      }))

      await doFetch(`${BACKEND_URL}/api/stress/${type}`, 'POST')

      // Confirm with status poll
      await refreshStressStatus()

      setStress((prev) => ({
        ...prev,
        loading: { ...prev.loading, [type]: false },
      }))
    },
    [stress, doFetch, refreshStressStatus]
  )

  // -- Traffic generator
  const [traffic, setTraffic] = useState<TrafficState>({
    running: false,
    flow: '1',
    batchSize: 5,
    interval: 500,
    sent: 0,
    success: 0,
    errors: 0,
  })
  const trafficRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trafficActiveRef = useRef(false)

  const getTrafficUrl = (flow: string): { url: string; method: string } => {
    switch (flow) {
      case '1': return { url: `${BACKEND_URL}/api/flow/1`, method: 'GET' }
      case '2': return { url: `${BACKEND_URL}/api/flow/2`, method: 'GET' }
      case '3s': return { url: `${BACKEND_URL}/api/flow/3/success`, method: 'GET' }
      case '3t': return { url: `${BACKEND_URL}/api/flow/3/timeout`, method: 'GET' }
      case '4': return { url: `${BACKEND_URL}/api/flow/4`, method: 'POST' }
      case 'cascade': return { url: `${BACKEND_URL}/api/flow/cascade`, method: 'GET' }
      default: return { url: `${BACKEND_URL}/api/flow/1`, method: 'GET' }
    }
  }

  const runTrafficBatch = useCallback(
    async (flow: string, batchSize: number, interval: number) => {
      if (!trafficActiveRef.current) return

      const { url, method } = getTrafficUrl(flow)
      const promises = Array.from({ length: batchSize }, () => doFetch(url, method))
      const results = await Promise.allSettled(promises)

      if (!trafficActiveRef.current) return

      let batchSuccess = 0
      let batchErrors = 0
      results.forEach((r) => {
        if (r.status === 'fulfilled') {
          const { status, error } = r.value
          if (!error && status >= 200 && status < 300) batchSuccess++
          else batchErrors++
        } else {
          batchErrors++
        }
      })

      setTraffic((prev) => ({
        ...prev,
        sent: prev.sent + batchSize,
        success: prev.success + batchSuccess,
        errors: prev.errors + batchErrors,
      }))

      if (trafficActiveRef.current) {
        trafficRef.current = setTimeout(
          () => runTrafficBatch(flow, batchSize, interval),
          interval
        )
      }
    },
    [doFetch]
  )

  const stopTraffic = useCallback(() => {
    trafficActiveRef.current = false
    if (trafficRef.current) clearTimeout(trafficRef.current)
    setTraffic((prev) => ({ ...prev, running: false }))
  }, [])

  useEffect(() => {
    return () => {
      trafficActiveRef.current = false
      if (trafficRef.current) clearTimeout(trafficRef.current)
    }
  }, [])

  // Re-trigger traffic loop when start is called
  const handleStartTraffic = useCallback(() => {
    trafficActiveRef.current = true
    setTraffic((prev) => {
      const next = { ...prev, running: true, sent: 0, success: 0, errors: 0 }
      // Kick off loop
      setTimeout(() => runTrafficBatch(next.flow, next.batchSize, next.interval), 0)
      return next
    })
  }, [runTrafficBatch])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const flowKeys = Object.keys(FLOW_DEFINITIONS) as FlowKey[]

  return (
    <div className="min-h-screen" style={{ background: '#0F1117' }}>
      <Navbar health={health} clock={clock} />

      {/* Main content */}
      <main className="pt-20 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">

        {/* ------------------------------------------------------------------ */}
        {/* Section 1: API Flow Tests */}
        {/* ------------------------------------------------------------------ */}
        <section className="mb-10">
          <SectionHeader
            icon={<GitBranch size={16} />}
            title="API Flow Tests"
            subtitle="Trigger end-to-end request flows through the distributed service mesh"
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {flowKeys.map((key) => {
              const def = FLOW_DEFINITIONS[key]
              const state = flowStates[key]
              return (
                <FlowCard
                  key={key}
                  id={key}
                  title={def.title}
                  description={def.description}
                  method={def.method}
                  endpoint={def.endpoint}
                  state={state}
                  onSend={() => handleFlowSend(key)}
                  onToggleExpand={() => toggleExpanded(key)}
                />
              )
            })}
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Section 2: Stress Controls */}
        {/* ------------------------------------------------------------------ */}
        <section className="mb-10">
          <SectionHeader
            icon={<Zap size={16} />}
            title="Stress Controls"
            subtitle="Inject artificial load on specific service layers"
            action={
              <button
                onClick={refreshStressStatus}
                className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-dd-purple-light transition-colors px-3 py-1.5 rounded-lg"
                style={{ border: '1px solid #2A2D3A', background: 'rgba(42,45,58,0.4)' }}
              >
                <RefreshCw size={12} />
                Refresh Status
              </button>
            }
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StressCard
              icon={<Cpu size={16} />}
              title="CPU Stress"
              description="Spin up a CPU-intensive computation loop on the backend"
              active={stress.cpu}
              loading={stress.loading.cpu}
              onToggle={() => toggleStress('cpu')}
            />
            <StressCard
              icon={<HardDrive size={16} />}
              title="Memory Stress"
              description="Allocate large memory buffers to simulate memory pressure"
              active={stress.memory}
              loading={stress.loading.memory}
              onToggle={() => toggleStress('memory')}
            />
            <StressCard
              icon={<Database size={16} />}
              title="DB Stress"
              description="Flood the DB connection pool with slow, repeated queries"
              active={stress.db}
              loading={stress.loading.db}
              onToggle={() => toggleStress('db')}
            />
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Section 3: Traffic Generator + Section 4: Response Log (side by side) */}
        {/* ------------------------------------------------------------------ */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
          {/* Traffic Generator */}
          <section>
            <SectionHeader
              icon={<BarChart3 size={16} />}
              title="Traffic Generator"
              subtitle="Automate batched requests to stress-test endpoints"
            />
            <TrafficGenerator
              state={traffic}
              onChange={(patch) => setTraffic((prev) => ({ ...prev, ...patch }))}
              onStart={handleStartTraffic}
              onStop={stopTraffic}
            />
          </section>

          {/* Response Log */}
          <section>
            <SectionHeader
              icon={<Terminal size={16} />}
              title="Response Log"
              subtitle="Live feed of all outbound requests from this dashboard"
            />
            <ResponseLog entries={log} onClear={() => setLog([])} />
          </section>
        </div>

        {/* Footer */}
        <footer className="text-center text-xs text-text-secondary py-4" style={{ borderTop: '1px solid #2A2D3A' }}>
          <span>GridDog Observability Sandbox</span>
          <span className="mx-2 text-border">•</span>
          <span>Backend: <code className="font-mono text-dd-purple">{BACKEND_URL}</code></span>
          <span className="mx-2 text-border">•</span>
          <span className="text-text-secondary">
            Service health checks every 10s
          </span>
        </footer>
      </main>
    </div>
  )
}
