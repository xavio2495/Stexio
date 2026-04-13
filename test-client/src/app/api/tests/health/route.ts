import { NextResponse } from 'next/server'
import { pass, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const log: string[] = []

  try {
    log.push(`GET ${proxyUrl}/health`)
    const res = await fetch(`${proxyUrl}/health`, { cache: 'no-store' })
    log.push(`Status: ${res.status}`)

    if (!res.ok) {
      return NextResponse.json(fail(`Proxy returned HTTP ${res.status}`, log, undefined, Date.now() - t0))
    }

    const data = await res.json() as Record<string, unknown>
    log.push(`Response: ${JSON.stringify(data)}`)

    if (data.ok !== true) {
      return NextResponse.json(fail(`ok field is not true`, log, data, Date.now() - t0))
    }
    if (data.service !== 'stexio-proxy') {
      return NextResponse.json(fail(`Unexpected service name: ${data.service}`, log, data, Date.now() - t0))
    }

    log.push(`Network: ${data.network}`)
    return NextResponse.json(pass(`Proxy is up (network: ${data.network})`, log, data, Date.now() - t0))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(`Cannot reach proxy — is it running at ${proxyUrl}?`, log, undefined, Date.now() - t0))
  }
}
