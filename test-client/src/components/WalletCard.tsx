'use client'
import { useState } from 'react'
import { StatusBadge } from './StatusBadge'
import { LogPanel } from './LogPanel'
import type { TestStatus } from '@/lib/types'

interface FreighterApi {
  getPublicKey(): Promise<string>
  isConnected(): Promise<boolean>
}

declare global {
  interface Window {
    freighterApi?: FreighterApi
  }
}

export function WalletCard() {
  const [status, setStatus] = useState<TestStatus>('idle')
  const [message, setMessage] = useState('')
  const [log, setLog] = useState<string[]>([])

  const handleConnect = async () => {
    setStatus('running')
    setLog([])
    const newLog: string[] = []

    try {
      newLog.push('Checking for Freighter browser extension...')

      if (typeof window === 'undefined' || !window.freighterApi) {
        newLog.push('window.freighterApi not found')
        newLog.push('If Freighter is installed: open the extension → click the site URL → Allow access to this site')
        newLog.push('Freighter requires explicit per-site permission before injecting window.freighterApi')
        newLog.push('Install Freighter: https://www.freighter.app')
        setLog(newLog)
        setStatus('fail')
        setMessage('Freighter not detected — allow this site in the extension first')
        return
      }

      newLog.push('Freighter extension detected')
      const connected = await window.freighterApi.isConnected()
      newLog.push(`Is connected: ${connected}`)

      if (!connected) {
        newLog.push('Requesting public key (will prompt Freighter to connect)...')
      }

      const pubkey = await window.freighterApi.getPublicKey()
      newLog.push(`Public key: ${pubkey}`)

      if (!pubkey || !pubkey.startsWith('G') || pubkey.length !== 56) {
        newLog.push('Invalid public key format')
        setLog(newLog)
        setStatus('fail')
        setMessage(`Invalid public key returned: ${pubkey}`)
        return
      }

      setLog(newLog)
      setStatus('pass')
      setMessage(`Connected: ${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      newLog.push(`Error: ${msg}`)
      setLog(newLog)
      setStatus('fail')
      setMessage(msg)
    }
  }

  const borderColor = {
    idle: 'border-gray-700',
    running: 'border-blue-600',
    pass: 'border-green-600',
    warn: 'border-yellow-500',
    fail: 'border-red-600',
  }[status]

  return (
    <div className={`bg-gray-900 rounded-lg border-l-4 ${borderColor} p-4 transition-colors`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <StatusBadge status={status} />
            <h3 className="text-sm font-semibold text-white">Freighter Wallet</h3>
          </div>
          <p className="text-xs text-gray-400">
            Browser wallet connect via window.freighterApi — get public key from Freighter extension
          </p>
          {message && (
            <p className={`mt-2 text-xs font-medium ${
              status === 'pass' ? 'text-green-400' :
              status === 'fail' ? 'text-red-400' : 'text-gray-400'
            }`}>
              {message}
            </p>
          )}
        </div>

        <button
          onClick={handleConnect}
          disabled={status === 'running'}
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded bg-gray-700 hover:bg-gray-600 text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {status === 'running' ? '...' : 'Connect'}
        </button>
      </div>

      <LogPanel log={log} />
    </div>
  )
}
