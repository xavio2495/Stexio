import type { CallToolRequest, CallToolResult, Hook, RequestExtra } from "@stexio/js-sdk/handler"
import { config } from "dotenv"

config()

// ─── MPP Credential Types ─────────────────────────────────────────────────────

/**
 * MPP Charge credential — pay-per-request.
 * Client sends this for a one-time charge per call.
 */
interface MppChargeCredential {
  action: 'charge'
  network: string             // 'stellar:testnet' | 'stellar:pubnet'
  amount: string              // in stroops
  payTo: string               // G... server address
  token: string               // USDC C... address
  reference?: string          // optional client reference
  signature?: string          // optional credential signature
}

/**
 * MPP Session (voucher) credential — payment channel.
 * Client sends this for each call after channel is established.
 */
interface MppVoucherCredential {
  action: 'voucher'
  channelAddress: string      // C... deployed one-way-channel contract
  amount: string              // this call's price in stroops
  cumulativeAmount: string    // running total in stroops
  nonce?: string              // optional nonce
  signature: string           // hex Ed25519 over commitment bytes
}

type MppCredential = MppChargeCredential | MppVoucherCredential

type ToolCallResponseHookResult =
  | { resultType: 'continue'; response: CallToolResult }
  | { resultType: 'retry'; request: CallToolRequest }

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MPP_CREDENTIAL_HEADER = 'X-MPP-Credential'
const MPP_RECEIPT_HEADER = 'X-MPP-Receipt'

function parseMppCredential(header: string): MppCredential | null {
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8')
    const parsed = JSON.parse(decoded) as MppCredential
    if (!parsed.action) return null
    if (parsed.action !== 'charge' && parsed.action !== 'voucher') return null
    return parsed
  } catch {
    return null
  }
}

function isPaymentRequiredResponse(res: CallToolResult): boolean {
  const meta = (res?._meta as Record<string, unknown>) ?? {}
  const payload = meta["x402/error"] as { error?: string } | undefined
  if (!payload?.error) return false
  const normalized = payload.error.toLowerCase()
  return ['payment_required', 'invalid_payment', 'unable_to_match_payment_requirements'].includes(normalized)
}

/**
 * Build the MPP section of a 402 response.
 * This is SEPARATE from x402 accepts[] — it goes in a top-level `mpp` field.
 */
function buildMppRequirements(opts: {
  paymentModes: string[]
  serverAddress: string
  pricePerCall: string    // in stroops
  channelAddress?: string
  network?: 'testnet' | 'mainnet'
}): Record<string, unknown> | null {
  const net = opts.network ?? 'testnet'
  const networkId = net === 'testnet' ? 'stellar:testnet' : 'stellar:pubnet'
  const usdcAddress = net === 'testnet'
    ? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
    : 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

  if (opts.paymentModes.includes('mpp-charge')) {
    return {
      mppVersion: 1,
      intent: 'charge',
      network: networkId,
      payTo: opts.serverAddress,
      token: usdcAddress,
      pricePerRequest: opts.pricePerCall,
    }
  }

  if (opts.paymentModes.includes('mpp-session') && opts.channelAddress) {
    return {
      mppVersion: 1,
      intent: 'session',
      network: networkId,
      channel: opts.channelAddress,
      token: usdcAddress,
      pricePerRequest: opts.pricePerCall,
    }
  }

  return null
}

// ─── MPP Charge Verifier ──────────────────────────────────────────────────────

/**
 * Verify an MPP Charge credential.
 *
 * MPP Charge verification strategy:
 * 1. Check the credential is structurally valid
 * 2. Check the amount >= pricePerCall
 * 3. Check the payTo address matches our server address
 * 4. Optionally verify on-chain via @stellar/mpp SDK
 *
 * For the hackathon: structural verification is sufficient for demo.
 * Production: add on-chain verification via @stellar/mpp.
 */
async function verifyMppCharge(
  credential: MppChargeCredential,
  serverAddress: string,
  pricePerCall: bigint,
): Promise<{ valid: boolean; reason?: string }> {
  // Structural checks
  if (!credential.payTo) {
    return { valid: false, reason: 'missing payTo' }
  }
  if (credential.payTo !== serverAddress) {
    return { valid: false, reason: 'payTo mismatch' }
  }
  if (!credential.amount) {
    return { valid: false, reason: 'missing amount' }
  }

  const amount = BigInt(credential.amount)
  if (amount < pricePerCall) {
    return { valid: false, reason: `amount ${amount} < pricePerCall ${pricePerCall}` }
  }

  // TODO Production: verify on-chain via @stellar/mpp SDK
  // import { ChargeMethods } from '@stellar/mpp'
  // const verified = await ChargeMethods.verifyCharge(credential)
  // if (!verified) return { valid: false, reason: 'on-chain verification failed' }

  return { valid: true }
}

// ─── MPP Session Verifier ─────────────────────────────────────────────────────

/**
 * Verify an MPP Session (voucher) credential.
 *
 * Voucher verification:
 * 1. Decode the commitment bytes from the channel contract (simulate call)
 * 2. Verify the Ed25519 signature over those bytes
 * 3. Check cumulative amount is monotonically increasing
 *
 * For the hackathon: basic structural + cumulative amount verification.
 * The @stellar/mpp SDK handles the full commitment byte construction.
 */

// Track last seen cumulative amount per channel (in-memory)
// TODO Production: replace with persistent store (Redis) to survive restarts
const channelNonces = new Map<string, bigint>()

async function verifyMppVoucher(
  credential: MppVoucherCredential,
  pricePerCall: bigint,
): Promise<{ valid: boolean; reason?: string }> {
  if (!credential.channelAddress) {
    return { valid: false, reason: 'missing channelAddress' }
  }
  if (!credential.signature) {
    return { valid: false, reason: 'missing signature' }
  }
  if (!credential.cumulativeAmount) {
    return { valid: false, reason: 'missing cumulativeAmount' }
  }

  const cumulative = BigInt(credential.cumulativeAmount)
  const lastSeen = channelNonces.get(credential.channelAddress) ?? 0n

  // Cumulative must be strictly increasing
  if (cumulative <= lastSeen) {
    return { valid: false, reason: `cumulative ${cumulative} not > last seen ${lastSeen}` }
  }

  // Delta must cover at least one pricePerCall
  const delta = cumulative - lastSeen
  if (delta < pricePerCall) {
    return { valid: false, reason: `delta ${delta} < pricePerCall ${pricePerCall}` }
  }

  // TODO Production: verify signature via @stellar/mpp SDK
  // import { ChannelMethods } from '@stellar/mpp'
  // const verified = await ChannelMethods.verifyVoucher(credential)

  // Update tracking
  channelNonces.set(credential.channelAddress, cumulative)

  return { valid: true }
}

// ─── MppHook ─────────────────────────────────────────────────────────────────

export interface MppHookConfig {
  serverAddress: string       // G... Stellar address
  pricePerCall: bigint        // in stroops (7 decimals — 1 USDC = 10_000_000)
  paymentModes: string[]      // which MPP modes are enabled
  channelAddress?: string     // for mpp-session
  network?: 'testnet' | 'mainnet'
}

export class MppHook implements Hook {
  name = "mpp"

  constructor(private readonly cfg: MppHookConfig) {}

  async processCallToolRequest(req: CallToolRequest, extra: RequestExtra) {
    // Use inboundHeaders — the actual RequestExtra shape used by the proxy pipeline
    const mppHeader = extra.inboundHeaders?.get(MPP_CREDENTIAL_HEADER)

    if (!mppHeader) {
      // No MPP credential — let request through (x402 hooks may handle it)
      return { resultType: 'continue' as const, request: req }
    }

    const credential = parseMppCredential(mppHeader)
    if (!credential) {
      // Malformed credential — fall through to x402 hooks as fallback
      console.warn('[MppHook] Malformed MPP credential, falling through')
      return { resultType: 'continue' as const, request: req }
    }

    // Validate credential
    let valid = false
    let reason: string | undefined

    if (credential.action === 'charge') {
      const result = await verifyMppCharge(credential, this.cfg.serverAddress, this.cfg.pricePerCall)
      valid = result.valid
      reason = result.reason
    } else if (credential.action === 'voucher') {
      const result = await verifyMppVoucher(credential, this.cfg.pricePerCall)
      valid = result.valid
      reason = result.reason
    }

    if (!valid) {
      console.warn(`[MppHook] Credential rejected: ${reason}`)
      // Let x402 hooks handle it as a fallback
      return { resultType: 'continue' as const, request: req }
    }

    // Mark request as MPP-paid so downstream tools know
    const originalParams = (req?.params ?? {}) as Record<string, unknown>
    const originalMeta = (originalParams['_meta'] as Record<string, unknown>) ?? {}
    const patchedRequest: CallToolRequest = {
      ...req,
      params: {
        ...originalParams,
        _meta: {
          ...originalMeta,
          'mpp/paid': true,
          'mpp/action': credential.action,
          'mpp/credential': mppHeader,
        },
      },
    } as unknown as CallToolRequest

    return { resultType: 'continue' as const, request: patchedRequest }
  }

  async processCallToolResult(
    res: CallToolResult,
    req: CallToolRequest,
    extra: RequestExtra
  ): Promise<ToolCallResponseHookResult> {
    // If response is successful and was MPP-paid, set receipt header
    const meta = (req?.params as Record<string, unknown>)?._meta as Record<string, unknown> | undefined
    if (meta?.['mpp/paid']) {
      // Attach receipt to result meta
      const resultMeta = (res._meta as Record<string, unknown>) ?? {}
      return {
        resultType: 'continue',
        response: {
          ...res,
          _meta: {
            ...resultMeta,
            [MPP_RECEIPT_HEADER]: {
              success: true,
              action: meta['mpp/action'],
              network: this.cfg.network ?? 'testnet',
              timestamp: new Date().toISOString(),
            },
          },
        },
      }
    }

    // If payment is required and we have MPP modes, advertise them
    if (isPaymentRequiredResponse(res)) {
      const errorMeta = ((res._meta as Record<string, unknown>)?.['x402/error'] as Record<string, unknown>) ?? {}
      const mppReqs = buildMppRequirements({
        paymentModes: this.cfg.paymentModes,
        serverAddress: this.cfg.serverAddress,
        pricePerCall: this.cfg.pricePerCall.toString(),
        channelAddress: this.cfg.channelAddress,
        network: this.cfg.network,
      })

      if (mppReqs) {
        return {
          resultType: 'continue',
          response: {
            ...res,
            _meta: {
              ...(res._meta as Record<string, unknown>),
              'x402/error': { ...errorMeta, mpp: mppReqs },
            },
          },
        }
      }
    }

    return { resultType: 'continue', response: res }
  }
}
