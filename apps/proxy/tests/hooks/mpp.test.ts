import { describe, it, expect, vi } from 'vitest'
import { MppHook } from '../../src/lib/hooks/mpp-hook.js'

// Mock mppx for unit tests (real mppx requires Stellar infrastructure)
vi.mock('mppx/server', () => ({
  Mppx: {
    create: (options: any) => {
      // Determine if this is charge or channel mode based on methods
      const isCharge = options.methods?.[0]?.recipient !== undefined
      return {
        charge: () => async (req: Request) => {
          const auth = req.headers.get('Authorization') ?? ''
          if (!auth.startsWith('Payment ')) return { status: 402, challenge: new Response('', { status: 402 }) }

          // Simple validation: if payload contains certain markers, reject
          try {
            const payload = auth.slice(8) // Skip "Payment "
            const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())

            // Reject if wrong payTo (doesn't match expected server address)
            if (decoded.payTo && decoded.payTo !== 'GABC123STELLAR0ADDRESS0HERE0ABCDEFGHIJ0KLMNO0PQRSTUVWXYZ') {
              return { status: 402, challenge: new Response('', { status: 402 }) }
            }

            // Reject if insufficient amount (less than 1000000)
            if (decoded.amount && BigInt(decoded.amount) < 1000000n) {
              return { status: 402, challenge: new Response('', { status: 402 }) }
            }
          } catch {
            // If we can't parse, let through
          }

          return { status: 200, withReceipt: (res: Response) => res }
        },
        channel: () => async (req: Request) => {
          const auth = req.headers.get('Authorization') ?? ''
          if (!auth.startsWith('Payment ')) return { status: 402, challenge: new Response('', { status: 402 }) }
          return { status: 200, withReceipt: (res: Response) => res }
        },
      }
    },
  },
  Store: {
    upstash: () => ({}),
  },
}))

// Mock @stellar/mpp
vi.mock('@stellar/mpp/charge/server', () => ({
  stellar: {
    charge: () => ({}),
  },
}))

vi.mock('@stellar/mpp/channel/server', () => ({
  stellar: {
    channel: () => ({}),
  },
}))

vi.mock('@stellar/mpp', () => ({
  USDC_SAC_TESTNET: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  USDC_SAC_MAINNET: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
}))

const BASE_CONFIG = {
  serverAddress: 'GABC123STELLAR0ADDRESS0HERE0ABCDEFGHIJ0KLMNO0PQRSTUVWXYZ',
  pricePerCall: 1_000_000n,  // 0.1 USDC
  paymentModes: ['mpp-charge', 'mpp-session'],
  network: 'testnet' as const,
}


function buildChargeHeader(amount: string, payTo: string): string {
  // mppx wire format: "Payment <base64url(JSON)>"
  // In mocked version, just needs to start with "Payment "
  const payload = Buffer.from(JSON.stringify({
    action: 'charge',
    network: 'stellar:testnet',
    amount,
    payTo,
    token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  })).toString('base64url')
  return `Payment ${payload}`
}

function buildVoucherHeader(channelAddress: string, cumulative: string): string {
  // mppx wire format: "Payment <base64url(JSON)>"
  const payload = Buffer.from(JSON.stringify({
    action: 'voucher',
    channelAddress,
    amount: '1000000',
    cumulativeAmount: cumulative,
    signature: 'abc123',
  })).toString('base64url')
  return `Payment ${payload}`
}

function makePaymentRequiredResult(): any {
  return {
    isError: true,
    _meta: { 'x402/error': { error: 'PAYMENT_REQUIRED', accepts: [] } },
    content: [{ type: 'text', text: '{}' }],
  }
}

describe('MppHook', () => {
  it('passes through requests with no MPP header', async () => {
    const hook = new MppHook(BASE_CONFIG)
    const req = { method: 'tools/call', params: { name: 'weather', arguments: {} } } as any

    const result = await hook.processCallToolRequest(req, {} as any)
    expect(result.resultType).toBe('continue')
    expect((result.request as any).params?.name).toBe('weather')
  })

  it('accepts valid MPP charge credential', async () => {
    const hook = new MppHook(BASE_CONFIG)
    const header = buildChargeHeader('1000000', BASE_CONFIG.serverAddress)
    const req = { method: 'tools/call', params: { name: 'weather', arguments: {} } } as any
    const extra = { inboundHeaders: new Headers({ 'Authorization': header }) } as any

    const result = await hook.processCallToolRequest(req, extra)
    expect(result.resultType).toBe('continue')
    // Request should be marked as MPP-paid
    const meta = (result.request as any).params?._meta
    expect(meta?.['mpp/paid']).toBe(true)
    expect(meta?.['mpp/action']).toBe('charge')
  })

  it('rejects charge with wrong payTo address', async () => {
    const hook = new MppHook(BASE_CONFIG)
    const header = buildChargeHeader('1000000', 'GWRONGADDRESS000000000000000000000000000000000000000000')
    const req = { method: 'tools/call', params: { name: 'weather', arguments: {} } } as any
    const extra = { inboundHeaders: new Headers({ 'Authorization': header }) } as any

    const result = await hook.processCallToolRequest(req, extra)
    // Falls through without mpp/paid mark
    const meta = (result.request as any).params?._meta
    expect(meta?.['mpp/paid']).toBeFalsy()
  })

  it('rejects charge with insufficient amount', async () => {
    const hook = new MppHook(BASE_CONFIG)
    const header = buildChargeHeader('100', BASE_CONFIG.serverAddress)  // too low
    const req = { method: 'tools/call', params: { name: 'weather', arguments: {} } } as any
    const extra = { inboundHeaders: new Headers({ 'Authorization': header }) } as any

    const result = await hook.processCallToolRequest(req, extra)
    const meta = (result.request as any).params?._meta
    expect(meta?.['mpp/paid']).toBeFalsy()
  })

  it('accepts valid MPP voucher with increasing cumulative', async () => {
    // For channel mode, hook needs channelAddress and commitmentPubkey
    const channelAddr = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const hookConfig = {
      ...BASE_CONFIG,
      paymentModes: ['mpp-session'],
      channelAddress: channelAddr,
      commitmentPubkey: 'GBYVR4GLBULB424LLYNXA75HNQJG34VCL2GU7LSSLK5PBYTOETXGZXN',
    }
    const hook = new MppHook(hookConfig)
    const header = buildVoucherHeader(channelAddr, '1000000')
    const req = { method: 'tools/call', params: { name: 'weather', arguments: {} } } as any
    const extra = { inboundHeaders: new Headers({ 'Authorization': header }) } as any

    const result = await hook.processCallToolRequest(req, extra)
    const meta = (result.request as any).params?._meta
    expect(meta?.['mpp/paid']).toBe(true)
    expect(meta?.['mpp/action']).toBe('channel')  // channel mode, not charge
  })

  it('advertises MPP in 402 response when no credential', async () => {
    const hook = new MppHook(BASE_CONFIG)
    const paymentReq = makePaymentRequiredResult()
    const req = { method: 'tools/call', params: {} } as any

    const result = await hook.processCallToolResult(paymentReq, req, {} as any)
    expect(result.resultType).toBe('continue')
    const mppInfo = (result.response._meta as any)?.['x402/error']?.mpp
    expect(mppInfo?.intent).toBe('charge')
    expect(mppInfo?.mppVersion).toBe(1)
  })
})
