import type { TestResult } from './types'

export interface McpToolCallResult {
  result: {
    isError?: boolean
    content?: Array<{ type: string; text: string }>
    _meta?: Record<string, unknown>
  }
  rawResponse: unknown
}

/**
 * Send a single MCP tools/call JSON-RPC request through the proxy.
 * Returns the parsed result object (not the JSON-RPC envelope).
 */
export async function callProxyTool(
  proxyUrl: string,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<McpToolCallResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })

  const response = await fetch(`${proxyUrl}/mcp?id=${encodeURIComponent(serverId)}`, {
    method: 'POST',
    headers,
    body,
    cache: 'no-store',
  })

  const data = (await response.json()) as Record<string, unknown>
  // Proxy wraps in jsonrpc envelope OR returns bare result
  const result = (data.result ?? data) as McpToolCallResult['result']
  return { result, rawResponse: data }
}

/**
 * Check if an MCP result contains a payment-required error.
 */
export function isPaymentRequired(result: McpToolCallResult['result']): boolean {
  const meta = result._meta as Record<string, unknown> | undefined
  const x402error = meta?.['x402/error'] as { error?: string } | undefined
  if (!x402error?.error) return false
  return ['payment_required', 'invalid_payment', 'unable_to_match_payment_requirements']
    .includes(x402error.error.toLowerCase())
}

/**
 * Extract x402 accepts array from a payment-required result.
 */
export function getAccepts(result: McpToolCallResult['result']): Array<Record<string, unknown>> {
  const meta = result._meta as Record<string, unknown> | undefined
  const x402error = meta?.['x402/error'] as { accepts?: Array<Record<string, unknown>> } | undefined
  return x402error?.accepts ?? []
}

/**
 * Extract MPP requirements from a payment-required result.
 */
export function getMppRequirements(result: McpToolCallResult['result']): Record<string, unknown> | null {
  const meta = result._meta as Record<string, unknown> | undefined
  const x402error = meta?.['x402/error'] as { mpp?: Record<string, unknown> } | undefined
  return x402error?.mpp ?? null
}

/**
 * Helper to build a consistent pass/fail result.
 */
export function pass(message: string, log: string[], details?: unknown, durationMs?: number): TestResult {
  return { status: 'pass', message, log, details, durationMs }
}

export function warn(message: string, log: string[], details?: unknown, durationMs?: number): TestResult {
  return { status: 'warn', message, log, details, durationMs }
}

export function fail(message: string, log: string[], details?: unknown, durationMs?: number): TestResult {
  return { status: 'fail', message, log, details, durationMs }
}
