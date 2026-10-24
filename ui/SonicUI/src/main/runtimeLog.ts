import { redactDiagnosticReport } from './diagnosticReport'

export type RuntimeLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error'
export interface RuntimeLogEntry {
  at: string
  level: RuntimeLogLevel
  message: string
}
export interface RuntimeLogSnapshot {
  capturedAt: string
  truncated: boolean
  entries: RuntimeLogEntry[]
}
export interface RuntimeLogBufferOptions {
  maxEntries?: number
  maxChars?: number
  maxEntryChars?: number
}

const SENSITIVE_KEY = /url|cookie|authorization|token|password|secret|header|path|api[_-]?key/i
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_CHARS = 150_000
const DEFAULT_MAX_ENTRY_CHARS = 4_000

function safeValue(value: unknown, depth: number, seen: WeakSet<object>, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[redacted]'
  if (typeof value === 'string') return redactDiagnosticReport(value)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return '[undefined]'
  if (typeof value === 'function') return '[function]'
  if (typeof value !== 'object') return String(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeValue(value.message, depth + 1, seen, 'message'),
      stack:
        typeof value.stack === 'string'
          ? safeValue(value.stack, depth + 1, seen, 'stack')
          : undefined
    }
  }
  if (Buffer.isBuffer(value)) return `[binary data: ${value.length} bytes]`
  if (seen.has(value)) return '[circular]'
  if (depth >= 4) return '[nested object omitted]'
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.slice(0, 30).map((item) => safeValue(item, depth + 1, seen))
    if (value.length > 30) result.push(`[+${value.length - 30} items omitted]`)
    return result
  }
  const result: Record<string, unknown> = {}
  for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
    result[childKey] = safeValue(childValue, depth + 1, seen, childKey)
  }
  if (Object.keys(value).length > 50) result._omittedFields = true
  return result
}

function messageOf(values: unknown[], maxEntryChars: number): string {
  const seen = new WeakSet<object>()
  const rendered = values.map((value) => {
    const clean = safeValue(value, 0, seen)
    if (typeof clean === 'string') return clean
    try {
      return JSON.stringify(clean)
    } catch {
      return '[unserializable log value]'
    }
  })
  const result = rendered.join(' ')
  return result.length > maxEntryChars ? result.slice(0, maxEntryChars) + '…[truncated]' : result
}

/** A bounded, redaction-first in-memory log ring. It never writes raw log arguments to disk. */
export function createRuntimeLogBuffer(options: RuntimeLogBufferOptions = {}): {
  append: (level: RuntimeLogLevel, ...values: unknown[]) => void
  snapshot: () => RuntimeLogSnapshot
} {
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES))
  const maxChars = Math.max(1_000, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS))
  const maxEntryChars = Math.max(100, Math.floor(options.maxEntryChars ?? DEFAULT_MAX_ENTRY_CHARS))
  const entries: RuntimeLogEntry[] = []
  let sizeChars = 0
  let truncated = false

  const append = (level: RuntimeLogLevel, ...values: unknown[]): void => {
    const entry: RuntimeLogEntry = {
      at: new Date().toISOString(),
      level,
      message: messageOf(values, maxEntryChars)
    }
    if (entry.message.length > maxChars) {
      entry.message = entry.message.slice(0, maxChars) + '…[truncated]'
      truncated = true
    }
    entries.push(entry)
    sizeChars += entry.message.length
    while (entries.length > maxEntries || sizeChars > maxChars) {
      const removed = entries.shift()
      if (removed) sizeChars -= removed.message.length
      truncated = true
    }
  }

  const snapshot = (): RuntimeLogSnapshot => ({
    capturedAt: new Date().toISOString(),
    truncated,
    entries: entries.map((entry) => ({ ...entry }))
  })

  return { append, snapshot }
}

const runtimeLogBuffer = createRuntimeLogBuffer()
let captureInstalled = false

/** Capture recent main-process console output while preserving normal console behavior. */
export function installRuntimeLogCapture(): void {
  if (captureInstalled) return
  captureInstalled = true
  const levels: RuntimeLogLevel[] = ['debug', 'info', 'log', 'warn', 'error']
  for (const level of levels) {
    const original = console[level].bind(console) as (...args: unknown[]) => void
    Object.defineProperty(console, level, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        try {
          runtimeLogBuffer.append(level, ...args)
        } catch {
          // Logging must never become a second source of application failures.
        }
        original(...args)
      }
    })
  }
}

export function getRuntimeLogSnapshot(): RuntimeLogSnapshot {
  return runtimeLogBuffer.snapshot()
}
