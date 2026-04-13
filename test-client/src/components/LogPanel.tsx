'use client'
import { useState } from 'react'

interface LogPanelProps {
  log: string[]
  details?: unknown
}

export function LogPanel({ log, details }: LogPanelProps) {
  const [open, setOpen] = useState(false)
  const [showDetails, setShowDetails] = useState(false)

  if (log.length === 0) return null

  return (
    <div className="mt-3 text-xs">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 text-gray-400 hover:text-gray-200 transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="currentColor" viewBox="0 0 20 20"
        >
          <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
        </svg>
        {open ? 'Hide' : 'Show'} log ({log.length} lines)
      </button>

      {open && (
        <div className="mt-2 bg-gray-950 rounded border border-gray-700 p-3 font-mono overflow-x-auto">
          {log.map((line, i) => (
            <div key={i} className="text-gray-300 leading-5">
              <span className="text-gray-600 select-none mr-2">{String(i + 1).padStart(2, '0')}</span>
              {line}
            </div>
          ))}

          {details !== undefined && (
            <div className="mt-2 border-t border-gray-700 pt-2">
              <button
                onClick={() => setShowDetails(v => !v)}
                className="text-gray-500 hover:text-gray-300 text-xs transition-colors"
              >
                {showDetails ? '▼' : '▶'} Raw details
              </button>
              {showDetails && (
                <pre className="mt-1 text-gray-400 text-xs whitespace-pre-wrap break-all">
                  {JSON.stringify(details, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
