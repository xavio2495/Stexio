import type { TestStatus } from '@/lib/types'

const STATUS_CONFIG: Record<TestStatus, { label: string; className: string }> = {
  idle:    { label: 'Idle',    className: 'bg-gray-700 text-gray-300' },
  running: { label: 'Running', className: 'bg-blue-900 text-blue-200 animate-pulse' },
  pass:    { label: 'Pass',    className: 'bg-green-900 text-green-200' },
  warn:    { label: 'Warn',    className: 'bg-yellow-900 text-yellow-200' },
  fail:    { label: 'Fail',    className: 'bg-red-900 text-red-200' },
}

export function StatusBadge({ status }: { status: TestStatus }) {
  const { label, className } = STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${className}`}>
      {label}
    </span>
  )
}
