import { expect, test } from '@playwright/test'
import { redactDiagnosticReport } from '../src/main/diagnosticReport'
import { createRuntimeLogBuffer } from '../src/main/runtimeLog'

test('diagnostic reports redact signed URLs, credentials, and local paths without losing useful state', () => {
  const report = redactDiagnosticReport({
    application: { version: '2.6.0', platform: 'win32' },
    task: {
      status: 'error',
      fileName: 'test.bin',
      error:
        'GET https://example.test/file?token=secret failed at C:\\Users\\TS07\\Downloads\\test.bin',
      sourceUrl: 'https://example.test/file?sig=private',
      authorization: 'Bearer top-secret',
      retryCount: 3
    },
    networks: [{ label: 'Wi-Fi', status: 'error', error: 'token=secret' }]
  }) as {
    application: { version: string }
    task: {
      status: string
      error: string
      sourceUrl: string
      authorization: string
      retryCount: number
    }
    networks: { error: string }[]
  }

  expect(report.application.version).toBe('2.6.0')
  expect(report.task.status).toBe('error')
  expect(report.task.retryCount).toBe(3)
  expect(JSON.stringify(report)).not.toContain('example.test')
  expect(JSON.stringify(report)).not.toContain('top-secret')
  expect(JSON.stringify(report)).not.toContain('TS07')
  expect(report.task.sourceUrl).toBe('[redacted]')
  expect(report.task.authorization).toBe('[redacted]')
  expect(report.networks[0].error).toBe('token=[redacted]')
})

test('runtime diagnostics are redacted and bounded before export', () => {
  const logs = createRuntimeLogBuffer({ maxEntries: 2, maxChars: 1000, maxEntryChars: 300 })
  logs.append(
    'error',
    new Error(
      'GET https://example.test/file?token=secret failed at C:\\\\Users\\\\TS07\\\\Downloads\\\\test.bin'
    )
  )
  logs.append('warn', {
    cookie: 'sid=top-secret',
    authorization: 'Bearer another-secret',
    detail:
      'token=secret https://example.test/private C:\\\\Users\\\\TS07\\\\Downloads\\\\sample.bin'
  })
  logs.append('info', 'safe final event')

  const snapshot = logs.snapshot()
  const serialized = JSON.stringify(snapshot)
  expect(snapshot.entries).toHaveLength(2)
  expect(snapshot.truncated).toBe(true)
  expect(snapshot.entries.map((entry) => entry.level)).toEqual(['warn', 'info'])
  expect(serialized).not.toContain('example.test')
  expect(serialized).not.toContain('TS07')
  expect(serialized).not.toContain('top-secret')
  expect(serialized).not.toContain('another-secret')
  expect(serialized).not.toContain('sid=')
  expect(serialized).not.toContain('token=secret')
})
