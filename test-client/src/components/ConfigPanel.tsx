interface ConfigPanelProps {
  proxyUrl: string
}

export function ConfigPanel({ proxyUrl }: ConfigPanelProps) {
  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-4 mb-6">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Configuration</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
        <div className="flex gap-2">
          <span className="text-gray-500 shrink-0">Proxy URL</span>
          <span className="text-cyan-400">{proxyUrl}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-gray-500 shrink-0">Test MCP</span>
          <span className="text-cyan-400">localhost:3000/api/echo-mcp</span>
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        Configure <code className="text-gray-400">.env.local</code> for payment tests.
        See <code className="text-gray-400">.env.local.example</code> for all variables.
      </p>
    </div>
  )
}
