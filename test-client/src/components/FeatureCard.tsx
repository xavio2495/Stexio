'use client'
import { useState, useCallback } from 'react'
import { StatusBadge } from './StatusBadge'
import { LogPanel } from './LogPanel'
import type { TestStatus, TestResult } from '@/lib/types'

const BORDER_COLOR: Record<TestStatus, string> = {
  idle:    'border-gray-700',
  running: 'border-blue-600',
  pass:    'border-green-600',
  warn:    'border-yellow-500',
  fail:    'border-red-600',
}

interface FeatureCardProps {
  id: string
  title: string
  description: string
  status: TestStatus
  result: TestResult | null
  onRun: (id: string) => Promise<void>
}

export function FeatureCard({ id, title, description, status, result, onRun }: FeatureCardProps) {
  const [loading, setLoading] = useState(false)

  const handleRun = useCallback(async () => {
    setLoading(true)
    try {
      await onRun(id)
    } finally {
      setLoading(false)
    }
  }, [id, onRun])

  return (
    <div className={`bg-gray-900 rounded-lg border-l-4 ${BORDER_COLOR[status]} p-4 transition-colors`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <StatusBadge status={status} />
            <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
            {result?.durationMs != null && (
              <span className="text-xs text-gray-500 font-mono ml-auto shrink-0">{result.durationMs}ms</span>
            )}
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">{description}</p>
          {result && (
            <p className={`mt-2 text-xs font-medium ${
              status === 'pass' ? 'text-green-400' :
              status === 'warn' ? 'text-yellow-400' :
              status === 'fail' ? 'text-red-400' : 'text-gray-400'
            }`}>
              {result.message}
            </p>
          )}
        </div>

        <button
          onClick={handleRun}
          disabled={loading || status === 'running'}
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading || status === 'running' ? '...' : 'Run'}
        </button>
      </div>

      {result && (
        <LogPanel log={result.log} details={result.details} />
      )}
    </div>
  )
}
