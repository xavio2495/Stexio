'use client'
import { useState, useCallback } from 'react'
import { FeatureCard } from '@/components/FeatureCard'
import { WalletCard } from '@/components/WalletCard'
import { ConfigPanel } from '@/components/ConfigPanel'
import { FEATURE_TESTS, PROXY_URL } from '@/lib/config'
import type { TestStatus, TestResult } from '@/lib/types'

type TestState = {
  status: TestStatus
  result: TestResult | null
}

const initialState: Record<string, TestState> = Object.fromEntries(
  FEATURE_TESTS.map(f => [f.id, { status: 'idle', result: null }])
)

const GROUP_LABELS: Record<string, string> = {
  infrastructure: 'Infrastructure',
  auth: 'Authentication',
  registry: 'Server Registry',
  wallet: 'Wallet',
  payment: 'Payment Pipeline',
}

const GROUPS = ['infrastructure', 'auth', 'registry', 'payment'] as const

export default function Dashboard() {
  const [tests, setTests] = useState<Record<string, TestState>>(initialState)
  const [runningAll, setRunningAll] = useState(false)

  const runTest = useCallback(async (id: string) => {
    setTests(prev => ({ ...prev, [id]: { status: 'running', result: null } }))
    try {
      const res = await fetch(`/api/tests/${id}`, { cache: 'no-store' })
      const data = await res.json() as TestResult
      setTests(prev => ({ ...prev, [id]: { status: data.status, result: data } }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setTests(prev => ({
        ...prev,
        [id]: {
          status: 'fail',
          result: { status: 'fail', message: `Fetch error: ${msg}`, log: [msg] },
        },
      }))
    }
  }, [])

  const runAll = useCallback(async () => {
    setRunningAll(true)
    // Run in order — auth tests must precede apikey-mode
    for (const feature of FEATURE_TESTS) {
      if ((feature.id as string) === 'wallet') continue  // wallet is browser-only, skip in run-all
      if ((feature.id as string) === 'benchmark') continue  // benchmark runs all tests internally, skip in run-all
      await runTest(feature.id)
    }
    setRunningAll(false)
  }, [runTest])

  // Summary counts
  const counts = Object.values(tests).reduce(
    (acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc },
    {} as Record<string, number>
  )
  const total = FEATURE_TESTS.length + 1  // +1 for wallet card

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Stexio Test Client</h1>
            <p className="text-sm text-gray-400 mt-1">
              Feature verification dashboard — tests run against the live proxy at{' '}
              <code className="text-cyan-400">{PROXY_URL}</code>
            </p>
          </div>

          <div className="flex items-center gap-4">
            {/* Summary pills */}
            <div className="flex gap-2 text-xs font-semibold">
              {counts.pass   ? <span className="bg-green-900  text-green-200  px-2 py-0.5 rounded-full">✓ {counts.pass}</span>  : null}
              {counts.warn   ? <span className="bg-yellow-900 text-yellow-200 px-2 py-0.5 rounded-full">⚠ {counts.warn}</span>  : null}
              {counts.fail   ? <span className="bg-red-900    text-red-200    px-2 py-0.5 rounded-full">✗ {counts.fail}</span>  : null}
              {counts.running ? <span className="bg-blue-900  text-blue-200   px-2 py-0.5 rounded-full animate-pulse">⟳ {counts.running}</span> : null}
              <span className="bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">
                {total} tests
              </span>
            </div>

            <button
              onClick={runAll}
              disabled={runningAll}
              className="px-4 py-2 text-sm font-semibold rounded-md bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {runningAll ? 'Running...' : 'Run All Tests'}
            </button>
          </div>
        </div>
      </div>

      {/* Config */}
      <ConfigPanel proxyUrl={PROXY_URL} />

      {/* Feature groups */}
      {GROUPS.map(group => {
        const groupTests = FEATURE_TESTS.filter(f => f.group === group)
        if (groupTests.length === 0) return null
        return (
          <div key={group} className="mb-8">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              {GROUP_LABELS[group]}
            </h2>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {groupTests.map(feature => (
                <FeatureCard
                  key={feature.id}
                  id={feature.id}
                  title={feature.title}
                  description={feature.description}
                  status={tests[feature.id]?.status ?? 'idle'}
                  result={tests[feature.id]?.result ?? null}
                  onRun={runTest}
                />
              ))}
            </div>
          </div>
        )
      })}

      {/* Wallet card (separate — browser-only) */}
      <div className="mb-8">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Wallet
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <WalletCard />
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-xs text-gray-600 pt-4 border-t border-gray-800">
        Stexio Test Client — not a mock — all tests run against the live proxy
      </div>
    </div>
  )
}
