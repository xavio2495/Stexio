import { NextResponse } from 'next/server'
import { pass, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

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

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const email = process.env.TEST_AUTH_EMAIL ?? 'test@stexio.dev'
  const password = process.env.TEST_AUTH_PASSWORD ?? 'TestPassword123!'
  const log: string[] = []

  try {
    // Step 1: sign in to get token
    log.push(`Step 1: Sign in as ${email}`)
    const token = await signIn(proxyUrl, email, password)
    if (!token) {
      return NextResponse.json(fail('Could not obtain token — run auth-signup and auth-signin first', log, undefined, Date.now() - t0))
    }
    log.push(`Token obtained: ${token.slice(0, 16)}...`)

    // Step 2: fetch session using Bearer token
    log.push(`Step 2: GET ${proxyUrl}/api/auth/get-session`)
    const res = await fetch(`${proxyUrl}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    log.push(`Status: ${res.status}`)

    if (!res.ok) {
      const body = await res.text()
      log.push(`Body: ${body}`)
      return NextResponse.json(fail(`Session fetch returned ${res.status}`, log, undefined, Date.now() - t0))
    }

    const session = await res.json() as Record<string, unknown>
    const user = session.user as Record<string, unknown> | undefined
    log.push(`Session user: ${JSON.stringify(user ?? {})}`)

    if (!user?.email) {
      log.push(`Full session: ${JSON.stringify(session)}`)
      return NextResponse.json(fail('Session returned but user.email is missing', log, session, Date.now() - t0))
    }
    if (user.email !== email) {
      return NextResponse.json(fail(`Email mismatch: expected ${email}, got ${user.email}`, log, session, Date.now() - t0))
    }

    return NextResponse.json(pass(`Session verified for ${user.email}`, log, { userId: user.id, email: user.email }, Date.now() - t0))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
