/**
 * Built-in echo MCP server — requires payment.
 *
 * Returns payment_required if no x402/payment or mpp/paid meta is present.
 * The proxy's hooks verify/settle the payment and retry with meta set.
 *
 * Used by: payment-exact, payment-session, payment-mpp, mcp-unauth tests.
 */
import { NextRequest, NextResponse } from 'next/server'

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

function jsonRpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result }, {
    headers: { 'Content-Type': 'application/json' },
  })
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 })
  }

  const { id, method, params } = body as { id: unknown; method: string; params?: Record<string, unknown> }

  switch (method) {
    case 'initialize':
      return jsonRpc(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-mcp', version: '1.0.0' },
      })

    case 'tools/list':
      return jsonRpc(id, {
        tools: [{
          name: 'echo',
          description: 'Echo the input text back (requires payment)',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to echo' } },
            required: ['text'],
          },
        }],
      })

    case 'tools/call': {
      const meta = (params?._meta ?? {}) as Record<string, unknown>
      const hasX402 = !!meta['x402/payment']
      const hasMpp = !!meta['mpp/paid']

      if (!hasX402 && !hasMpp) {
        // No payment found — return payment_required so proxy hooks can settle
        const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
        const serverAddress = process.env.TEST_SERVER_STELLAR_ADDRESS ?? ''
        const contractId = process.env.TEST_SESSION_CONTRACT_ID ?? ''

        const accepts: unknown[] = [
          {
            scheme: 'exact',
            network: 'stellar-testnet',
            maxAmountRequired: '1000',
            payTo: recipient,
            asset: USDC_TESTNET,
            maxTimeoutSeconds: 300,
            resource: '/api/echo-mcp',
            description: 'Pay 0.0001 USDC to use the echo tool',
            mimeType: 'application/json',
            outputSchema: null,
            extra: null,
          },
        ]

        // Only include session accept if server address and contract are configured
        if (serverAddress && contractId) {
          accepts.push({
            scheme: 'session',
            network: 'stellar:testnet',
            server: serverAddress,
            contractId,
            pricePerCall: '1000',
            maxAmountRequired: '1000',
          })
        }

        return jsonRpc(id, {
          isError: true,
          content: [{ type: 'text', text: 'Payment required to use the echo tool.' }],
          _meta: {
            'x402/error': {
              error: 'payment_required',
              x402Version: 1,
              accepts,
            },
          },
        })
      }

      // Payment verified by proxy — return success
      const text = (params?.arguments as Record<string, unknown> | undefined)?.text ?? '(no text)'
      return jsonRpc(id, {
        content: [{ type: 'text', text: `Echo: ${text}` }],
      })
    }

    default:
      return NextResponse.json({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      })
  }
}

// Handle GET (SSE init) — not needed for our tests but prevents 405
export async function GET() {
  return new NextResponse(null, { status: 200 })
}
