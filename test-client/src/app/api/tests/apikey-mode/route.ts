import { NextResponse } from 'next/server'
import { callProxyTool, pass, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const SERVER_ID = 'test-echo-free'

async function signIn(proxyUrl: string, email: string, password: string): Promise<string | null> {
  const res = await fetch(`${proxyUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: proxyUrl },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  })
  if (!res.ok) return null
  const data = await res.json() as Record<string, unknown>
  return (data.token as string | undefined) ?? null
}

async function ensureServerRegistered(proxyUrl: string, testClientUrl: string) {
  await fetch(`${proxyUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: SERVER_ID,
      mcpOrigin: `${testClientUrl}/api/echo-mcp-free`,
      // No payment config — free tool, tests auth integration
      tools: [],
    }),
    cache: 'no-store',
  })
}

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const testClientUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3001'
  const email = process.env.TEST_AUTH_EMAIL ?? 'test@stexio.dev'
  const password = process.env.TEST_AUTH_PASSWORD ?? 'TestPassword123!'
  const log: string[] = []

  try {
    // Step 1: Sign in to get Bearer token
    log.push(`Step 1: Sign in as ${email}`)
    const token = await signIn(proxyUrl, email, password)
    if (!token) {
      return NextResponse.json(fail(
        'Could not sign in — run auth-signup first, then auth-signin',
        log, undefined, Date.now() - t0
      ))
    }
    log.push(`Token obtained: ${token.slice(0, 16)}...`)

    // Step 2: Register free echo server
    log.push(`Step 2: Register free echo server (id: ${SERVER_ID})`)
    await ensureServerRegistered(proxyUrl, testClientUrl)
    log.push('Server registered')

    // Step 3: Call tool with Authorization: Bearer header
    log.push(`Step 3: Call tool with Authorization: Bearer <token>`)
    const { result } = await callProxyTool(
      proxyUrl, SERVER_ID, 'echo', { text: 'api key test' },
      { Authorization: `Bearer ${token}` }
    )
    log.push(`isError: ${result.isError}`)
    log.push(`Content: ${JSON.stringify(result.content)}`)

    if (result.isError) {
      log.push(`Full result: ${JSON.stringify(result)}`)
      return NextResponse.json(fail(
        'Tool call failed even with valid Bearer token — check proxy auth configuration',
        log, result, Date.now() - t0
      ))
    }

    const text = result.content?.[0]?.text ?? ''
    if (!text.includes('Echo')) {
      return NextResponse.json(fail(`Unexpected response: ${text}`, log, result, Date.now() - t0))
    }

    return NextResponse.json(pass(
      `API Key Mode: Bearer token accepted, tool responded: "${text}"`,
      log,
      { response: text },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
