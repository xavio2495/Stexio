import { NextResponse } from 'next/server'
import { pass, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const testClientUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3000'
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
  const log: string[] = []

  if (!recipient) {
    return NextResponse.json({
      status: 'warn',
      message: 'TEST_RECIPIENT_ADDRESS not set — register will succeed but no payment recipient configured',
      log: ['Set TEST_RECIPIENT_ADDRESS in .env.local to a funded G... testnet address'],
      durationMs: Date.now() - t0,
    })
  }

  const payload = {
    id: 'test-echo-register',
    mcpOrigin: `${testClientUrl}/api/echo-mcp`,
    recipient: { stellar: { address: recipient, isTestnet: true } },
    paymentModes: ['x402-exact'],
    tools: [{ name: 'echo', pricing: '$0.0001' }],
    metadata: { purpose: 'stexio-test-client registration test' },
  }

  try {
    log.push(`POST ${proxyUrl}/register`)
    log.push(`Payload: ${JSON.stringify(payload)}`)

    const res = await fetch(`${proxyUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    })

    log.push(`Status: ${res.status}`)
    const data = await res.json() as Record<string, unknown>
    log.push(`Response: ${JSON.stringify(data)}`)

    if (!res.ok || !data.ok) {
      return NextResponse.json(fail(`Register failed: ${JSON.stringify(data)}`, log, data, Date.now() - t0))
    }

    return NextResponse.json(pass(`Server registered with id: ${data.id}`, log, data, Date.now() - t0))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
