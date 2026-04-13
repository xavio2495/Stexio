import { NextResponse } from 'next/server'
import { pass, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const email = process.env.TEST_AUTH_EMAIL ?? 'test@stexio.dev'
  const password = process.env.TEST_AUTH_PASSWORD ?? 'TestPassword123!'
  const log: string[] = []

  try {
    log.push(`POST ${proxyUrl}/api/auth/sign-in/email`)
    log.push(`Email: ${email}`)

    const res = await fetch(`${proxyUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: proxyUrl },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    })

    log.push(`Status: ${res.status}`)
    const data = await res.json() as Record<string, unknown>
    log.push(`Response keys: ${Object.keys(data).join(', ')}`)

    if (!res.ok) {
      return NextResponse.json(fail(`Sign-in failed with status ${res.status} — run auth-signup first`, log, data, Date.now() - t0))
    }

    // better-auth returns { token, user }
    const token = (data.token as string | undefined) ?? (data.session as Record<string, unknown> | undefined)?.token as string | undefined
    if (!token) {
      log.push(`Full response: ${JSON.stringify(data)}`)
      return NextResponse.json(fail('No token in sign-in response', log, data, Date.now() - t0))
    }

    log.push(`Token: ${token.slice(0, 16)}...`)
    log.push(`User: ${JSON.stringify((data.user as Record<string, unknown> | undefined) ?? {})}`)
    return NextResponse.json(pass(`Sign-in successful, token obtained`, log, { token: token.slice(0, 16) + '...' }, Date.now() - t0))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(`Cannot reach proxy — is it running at ${proxyUrl}?`, log, undefined, Date.now() - t0))
  }
}
