import { NextResponse } from 'next/server'
import type { TestResult } from '@/lib/types'

const TEST_IDS = [
  'health',
  'auth-signup',
  'auth-signin',
  'auth-session',
  'server-register',
  'server-list',
  'mcp-unauth',
  'payment-x402-coinbase',
  'payment-x402-stellar',
  'payment-turbo',
  'payment-mpp',
  'payment-mpp-session',
  'apikey-mode',
]

const STATUS_ICON: Record<string, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
}

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const baseUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3001'
  const log: string[] = []
  const results: Array<{ id: string; status: string; durationMs: number }> = []

  log.push(`Running ${TEST_IDS.length} tests sequentially against ${baseUrl}`)

  for (const id of TEST_IDS) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}/api/tests/${id}`, { cache: 'no-store' })
      const data = await res.json() as TestResult
      const dur = data.durationMs ?? (Date.now() - start)
      const icon = STATUS_ICON[data.status] ?? '?'
      log.push(`${id}: ${dur}ms ${icon} — ${data.message}`)
      results.push({ id, status: data.status, durationMs: dur })
    } catch (err) {
      const dur = Date.now() - start
      const msg = err instanceof Error ? err.message : String(err)
      log.push(`${id}: ${dur}ms ✗ — fetch error: ${msg}`)
      results.push({ id, status: 'fail', durationMs: dur })
    }
  }

  const totalMs = Date.now() - t0
  const sorted = [...results].sort((a, b) => b.durationMs - a.durationMs)
  const slowest = sorted[0]?.id ?? 'none'
  const fastest = sorted[sorted.length - 1]?.id ?? 'none'
  const failCount = results.filter(r => r.status === 'fail').length
  const warnCount = results.filter(r => r.status === 'warn').length

  log.push(``)
  log.push(`Total: ${totalMs}ms | Slowest: ${slowest} (${sorted[0]?.durationMs}ms) | Fastest: ${fastest} (${sorted[sorted.length - 1]?.durationMs}ms)`)
  log.push(`Results: ${results.length - failCount - warnCount} pass, ${warnCount} warn, ${failCount} fail`)

  const overallStatus = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass'
  const message = `Benchmark: ${totalMs}ms total — ${results.length} tests (${failCount} fail, ${warnCount} warn)`

  return NextResponse.json({
    status: overallStatus,
    message,
    log,
    details: { results, totalMs, slowest, fastest },
    durationMs: totalMs,
  })
}
