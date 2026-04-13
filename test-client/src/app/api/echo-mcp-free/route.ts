/**
 * Free echo MCP server — no payment required.
 * Used by: apikey-mode test (tests proxy auth without payment).
 */
import { NextRequest, NextResponse } from 'next/server'

function jsonRpc(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result })
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
        serverInfo: { name: 'echo-mcp-free', version: '1.0.0' },
      })

    case 'tools/list':
      return jsonRpc(id, {
        tools: [{
          name: 'echo',
          description: 'Free echo — no payment required',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        }],
      })

    case 'tools/call': {
      const text = (params?.arguments as Record<string, unknown> | undefined)?.text ?? '(no text)'
      return jsonRpc(id, {
        content: [{ type: 'text', text: `Free Echo: ${text}` }],
      })
    }

    default:
      return NextResponse.json({
        jsonrpc: '2.0', id,
        error: { code: -32601, message: 'Method not found' },
      })
  }
}

export async function GET() {
  return new NextResponse(null, { status: 200 })
}
