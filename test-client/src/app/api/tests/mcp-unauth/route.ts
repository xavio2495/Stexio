import { NextResponse } from 'next/server'
import { callProxyTool, isPaymentRequired, getAccepts, pass, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const SERVER_ID = 'test-echo-unauth'

async function ensureServerRegistered(proxyUrl: string, testClientUrl: string, recipient: string) {
  await fetch(`${proxyUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: SERVER_ID,
      mcpOrigin: `${testClientUrl}/api/echo-mcp`,
      recipient: { stellar: { address: recipient, isTestnet: true } },
      paymentModes: ['x402-exact'],
      tools: [{ name: 'echo', pricing: '$0.0001' }],
    }),
    cache: 'no-store',
  })
}

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const testClientUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3001'
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGYWDNHFJITMAJ5RTIPINMR'
  const log: string[] = []

  try {
    log.push(`Step 1: Register echo server (id: ${SERVER_ID})`)
    await ensureServerRegistered(proxyUrl, testClientUrl, recipient)
    log.push('Server registered')

    log.push(`Step 2: tools/call 'echo' with NO payment headers`)
    const { result } = await callProxyTool(proxyUrl, SERVER_ID, 'echo', { text: 'hello' })
    log.push(`Result isError: ${result.isError}`)
    log.push(`Result _meta keys: ${Object.keys(result._meta ?? {}).join(', ')}`)

    if (!isPaymentRequired(result)) {
      log.push(`Full result: ${JSON.stringify(result)}`)
      return NextResponse.json(fail(
        'Expected payment_required error but got a successful response — payment hook may not be configured',
        log, result, Date.now() - t0
      ))
    }

    const accepts = getAccepts(result)
    log.push(`Payment required detected ✓`)
    log.push(`Accepts count: ${accepts.length}`)
    for (const a of accepts) {
      log.push(`  scheme=${a.scheme} network=${a.network} amount=${a.maxAmountRequired ?? a.pricePerCall}`)
    }

    if (accepts.length === 0) {
      return NextResponse.json(fail('payment_required returned but accepts[] is empty', log, result, Date.now() - t0))
    }

    return NextResponse.json(pass(
      `402 detection works — proxy correctly requires payment for unpaid tool calls`,
      log,
      { accepts },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
