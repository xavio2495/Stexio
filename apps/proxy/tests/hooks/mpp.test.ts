import { describe, it, expect } from 'vitest'
import { MppHook } from '../../src/lib/hooks/mpp-hook.js'

const BASE_CONFIG = {
  serverAddress: 'GABC123STELLAR0ADDRESS0HERE0ABCDEFGHIJ0KLMNO0PQRSTUVWXYZ',
  pricePerCall: 1_000_000n,  // 0.1 USDC
  paymentModes: ['mpp-charge', 'mpp-session'],
  network: 'testnet' as const,
}

function buildChargeHeader(amount: string, payTo: string): string {
  return Buffer.from(JSON.stringify({
    action: 'charge',
    network: 'stellar:testnet',
    amount,
    payTo,
    token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  })).toString('base64')
}

function buildVoucherHeader(channelAddress: string, cumulative: string): string {
  return Buffer.from(JSON.stringify({
    action: 'voucher',
    channelAddress,
    amount: '1000000',
    cumulativeAmount: cumulative,
    signature: 'abc123',
  })).toString('base64')
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
    const extra = { inboundHeaders: new Headers({ 'X-MPP-Credential': header }) } as any

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
    const extra = { inboundHeaders: new Headers({ 'X-MPP-Credential': header }) } as any

    const result = await hook.processCallToolRequest(req, extra)
    // Falls through without mpp/paid mark
    const meta = (result.request as any).params?._meta
    expect(meta?.['mpp/paid']).toBeFalsy()
  })

  it('rejects charge with insufficient amount', async () => {
    const hook = new MppHook(BASE_CONFIG)
    const header = buildChargeHeader('100', BASE_CONFIG.serverAddress)  // too low
    const req = { method: 'tools/call', params: { name: 'weather', arguments: {} } } as any
    const extra = { inboundHeaders: new Headers({ 'X-MPP-Credential': header }) } as any

    const result = await hook.processCallToolRequest(req, extra)
    const meta = (result.request as any).params?._meta
    expect(meta?.['mpp/paid']).toBeFalsy()
  })

  it('accepts valid MPP voucher with increasing cumulative', async () => {
    const hook = new MppHook(BASE_CONFIG)
    const channelAddr = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM'
    const header = buildVoucherHeader(channelAddr, '1000000')
    const req = { method: 'tools/call', params: { name: 'weather', arguments: {} } } as any
    const extra = { inboundHeaders: new Headers({ 'X-MPP-Credential': header }) } as any

    const result = await hook.processCallToolRequest(req, extra)
    const meta = (result.request as any).params?._meta
    expect(meta?.['mpp/paid']).toBe(true)
    expect(meta?.['mpp/action']).toBe('voucher')
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
