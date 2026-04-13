import { NextResponse } from 'next/server'
import { pass, warn, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const log: string[] = []

  try {
    log.push(`GET ${proxyUrl}/servers`)
    const res = await fetch(`${proxyUrl}/servers`, { cache: 'no-store' })
    log.push(`Status: ${res.status}`)

    if (!res.ok) {
      return NextResponse.json(fail(`/servers returned HTTP ${res.status}`, log, undefined, Date.now() - t0))
    }

    const data = await res.json() as { servers?: unknown[] }
    const servers = data.servers ?? []
    log.push(`Server count: ${servers.length}`)
    log.push(`Servers: ${JSON.stringify(servers)}`)

    if (servers.length === 0) {
      return NextResponse.json(warn('No servers registered yet — run server-register first', log, data, Date.now() - t0))
    }

    return NextResponse.json(pass(`${servers.length} server(s) registered`, log, data, Date.now() - t0))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
