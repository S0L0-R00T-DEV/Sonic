const SECRET_KEY = /url|cookie|authorization|token|password|secret|header/i
const SECRET_ASSIGNMENT =
  /\b(cookie|authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi
const WEB_URL = /https?:\/\/[^\s"'<>]+/gi
const AUTH_SCHEME = /\b(Bearer|Basic)\s+\S+/gi
const WINDOWS_PATH = /\b[A-Z]:\\[^\s"'<>]+/gi

/** Redact a diagnostic payload at the main-process boundary before writing it to disk. */
export function redactDiagnosticReport(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(WEB_URL, '[URL redacted]')
      .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
      .replace(AUTH_SCHEME, '$1 [redacted]')
      .replace(WINDOWS_PATH, '[local path redacted]')
  }
  if (Array.isArray(value)) return value.map(redactDiagnosticReport)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : redactDiagnosticReport(nested)
      ])
    )
  }
  return value
}
