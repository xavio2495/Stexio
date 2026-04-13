import { NextResponse } from 'next/server'
import { pass, warn, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const email = process.env.TEST_AUTH_EMAIL ?? 'test@stexio.dev'
  const password = process.env.TEST_AUTH_PASSWORD ?? 'TestPassword123!'
  const log: string[] = []

  try {
    log.push(`POST ${proxyUrl}/api/auth/sign-up/email`)
    log.push(`Email: ${email}`)

    const res = await fetch(`${proxyUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: proxyUrl },
      body: JSON.stringify({ email, password, name: 'Stexio Test User' }),
      cache: 'no-store',
    })

    log.push(`Status: ${res.status}`)
    const data = await res.json() as Record<string, unknown>
    log.push(`Response: ${JSON.stringify(data)}`)

    if (res.status === 200 || res.status === 201) {
      return NextResponse.json(pass(`Sign-up successful for ${email}`, log, data, Date.now() - t0))
    }

    // better-auth returns 422 if user already exists
    if (res.status === 422 || (data.code as string | undefined)?.includes('USER_ALREADY_EXISTS')) {
      return NextResponse.json(warn(`User already exists — sign-up flow was previously run`, log, data, Date.now() - t0))
    }

    return NextResponse.json(fail(`Sign-up failed with status ${res.status}`, log, data, Date.now() - t0))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(`Cannot reach proxy — is it running at ${proxyUrl}?`, log, undefined, Date.now() - t0))
  }
}
