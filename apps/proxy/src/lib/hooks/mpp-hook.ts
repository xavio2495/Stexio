import type { CallToolRequest, CallToolResult, Hook, RequestExtra } from "@stexio/js-sdk/handler"
import { Mppx, Store } from 'mppx/server'
import { stellar } from '@stellar/mpp/charge/server'
import { stellar as stellarChannel } from '@stellar/mpp/channel/server'
import { USDC_SAC_TESTNET, USDC_SAC_MAINNET } from '@stellar/mpp'
import { redis } from '../../db/redis.js'
import { config } from "dotenv"
import { appendFileSync } from 'fs'

config()

const MPP_RECEIPT_HEADER = 'X-MPP-Receipt'
const LOG_FILE = '/tmp/mpp-verify.log'

function writeLog(msg: string) {
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch (e) {
    // Fail silently if can't write
  }
}

type MppHandlerResult =
  | { status: 200; withReceipt: (res: Response) => Response }
  | { status: 402; challenge: Response }

type MppHandler = (req: Request) => Promise<MppHandlerResult>

type ToolCallResponseHookResult =
  | { resultType: 'continue'; response: CallToolResult }
  | { resultType: 'retry'; request: CallToolRequest }

function isPaymentRequiredResponse(res: CallToolResult): boolean {
  const meta = (res?._meta as Record<string, unknown>) ?? {}
  const payload = meta["x402/error"] as { error?: string } | undefined
  if (!payload?.error) return false
  const normalized = payload.error.toLowerCase()
  return ['payment_required', 'invalid_payment', 'unable_to_match_payment_requirements'].includes(normalized)
}

/**
 * Convert pricePerCall (bigint stroops) to a human-readable decimal string.
 * e.g. 1000n → "0.0001", 10_000_000n → "1"
 */
function stroopsToHuman(stroops: bigint): string {
  const totalDecimals = 7
  const str = stroops.toString().padStart(totalDecimals + 1, '0')
  const intPart = str.slice(0, -totalDecimals) || '0'
  const fracPart = str.slice(-totalDecimals).replace(/0+$/, '') || '0'
  return fracPart === '0' ? intPart : `${intPart}.${fracPart}`
}

// ─── MppHook ─────────────────────────────────────────────────────────────────

export interface MppHookConfig {
  serverAddress: string       // G... Stellar address (recipient for charge)
  pricePerCall: bigint        // in stroops (7 decimals — 1 USDC = 10_000_000)
  paymentModes: string[]      // which MPP modes are enabled
  channelAddress?: string     // C... one-way-channel contract (for mpp-session)
  commitmentPubkey?: string   // G... ed25519 commitment public key (for mpp-session)
  network?: 'testnet' | 'mainnet'
}

export class MppHook implements Hook {
  name = "mpp"

  // Pre-built mppx handler with the configured amount baked in
  private mppHandler: MppHandler
  private activeMode: 'charge' | 'channel'

  constructor(private readonly cfg: MppHookConfig) {
    const secretKey = process.env.MPP_SECRET_KEY
    if (!secretKey) throw new Error('[MppHook] MPP_SECRET_KEY env var is required')

    const usdcAddress = cfg.network === 'mainnet' ? USDC_SAC_MAINNET : USDC_SAC_TESTNET
    const stellarNetwork = cfg.network === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet'
    const humanAmount = stroopsToHuman(cfg.pricePerCall)

    if (cfg.paymentModes.includes('mpp-charge')) {
      this.activeMode = 'charge'
      const mppx = Mppx.create({
        secretKey,
        realm: 'stexio-mcp',
        methods: [
          stellar.charge({
            recipient: cfg.serverAddress,
            currency: usdcAddress,
            network: stellarNetwork,
          }),
        ],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.mppHandler = (mppx as any).charge({ amount: humanAmount }) as MppHandler
    } else if (cfg.paymentModes.includes('mpp-session') && cfg.channelAddress && cfg.commitmentPubkey) {
      this.activeMode = 'channel'
      const mppx = Mppx.create({
        secretKey,
        realm: 'stexio-mcp',
        methods: [
          stellarChannel.channel({
            channel: cfg.channelAddress,
            commitmentKey: cfg.commitmentPubkey,
            store: Store.upstash(redis),
            network: stellarNetwork,
          }),
        ],
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.mppHandler = (mppx as any).channel({ amount: humanAmount }) as MppHandler
    } else {
      throw new Error('[MppHook] No MPP methods could be configured (missing channelAddress/commitmentPubkey for session?)')
    }
  }

  async processCallToolRequest(req: CallToolRequest, extra: RequestExtra) {
    const authHeader = extra.inboundHeaders?.get('Authorization') ?? ''
    console.log('[MppHook] processCallToolRequest called, authHeader present:', !!authHeader)

    writeLog(`[AuthHeader] Present: ${!!authHeader}, Length: ${authHeader.length}`)
    if (authHeader) {
      writeLog(`[AuthHeader] Scheme: ${authHeader.split(' ')[0]}, Prefix: ${authHeader.slice(0, 100)}...`)
    }

    // Build synthetic request — mppx reads Authorization header from it
    const headers = new Headers()
    if (authHeader) headers.set('Authorization', authHeader)

    const syntheticReq = new Request('http://stexio-mcp/mcp', {
      method: 'POST',
      headers,
    })

    writeLog(`[MppHandler] Calling with mode: ${this.activeMode}`)

    let result: MppHandlerResult
    try {
      result = await this.mppHandler(syntheticReq)
      writeLog(`[MppHandler] Result status: ${result.status}`)

      if (result.status === 402) {
        writeLog(`[MppHandler] ✗ REJECTED - credential not accepted`)
      } else if (result.status === 200) {
        writeLog(`[MppHandler] ✓ ACCEPTED - credential valid!`)
      }
    } catch (err) {
      writeLog(`[MppHandler] ERROR: ${err instanceof Error ? err.message : String(err)}`)
      return { resultType: 'continue' as const, request: req }
    }

    const originalParams = (req?.params ?? {}) as Record<string, unknown>
    const originalMeta = (originalParams['_meta'] as Record<string, unknown>) ?? {}

    if (result.status === 200) {
      // Valid credential — mark request as MPP-paid
      console.log('[MppHook] ✓ Credential valid, marking mpp/paid')
      const patchedRequest: CallToolRequest = {
        ...req,
        params: {
          ...originalParams,
          _meta: {
            ...originalMeta,
            'mpp/paid': true,
            'mpp/action': this.activeMode,
          },
        },
      } as unknown as CallToolRequest

      return { resultType: 'continue' as const, request: patchedRequest }
    }

    // status === 402: no credential or invalid — store challenge for processCallToolResult
    console.log('[MppHook] ✗ Credential invalid or missing (status 402)')
    const wwwAuth = result.challenge?.headers?.get('WWW-Authenticate') ?? null

    const patchedRequest: CallToolRequest = {
      ...req,
      params: {
        ...originalParams,
        _meta: {
          ...originalMeta,
          ...(wwwAuth ? { 'mpp/challenge': wwwAuth } : {}),
        },
      },
    } as unknown as CallToolRequest

    return { resultType: 'continue' as const, request: patchedRequest }
  }

  async processCallToolResult(
    res: CallToolResult,
    req: CallToolRequest,
    _extra: RequestExtra
  ): Promise<ToolCallResponseHookResult> {
    const meta = (req?.params as Record<string, unknown>)?._meta as Record<string, unknown> | undefined

    // If request was MPP-paid → add receipt to result meta
    if (meta?.['mpp/paid']) {
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

    // If payment is required → embed mppx challenge in the mpp requirements
    if (isPaymentRequiredResponse(res)) {
      const net = this.cfg.network ?? 'testnet'
      const networkId = net === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet'
      const usdcAddress = net === 'mainnet' ? USDC_SAC_MAINNET : USDC_SAC_TESTNET

      const mppReqs: Record<string, unknown> = {
        mppVersion: 1,
        intent: this.activeMode === 'charge' ? 'charge' : 'session',
        network: networkId,
        payTo: this.cfg.serverAddress,
        token: usdcAddress,
        pricePerRequest: this.cfg.pricePerCall.toString(),
      }

      if (this.activeMode === 'channel' && this.cfg.channelAddress) {
        mppReqs.channel = this.cfg.channelAddress
      }

      // Embed the mppx challenge so client can build a proper credential
      const wwwAuth = meta?.['mpp/challenge'] as string | undefined
      if (wwwAuth) mppReqs.wwwAuthenticate = wwwAuth

      const errorMeta = ((res._meta as Record<string, unknown>)?.['x402/error'] as Record<string, unknown>) ?? {}
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

    return { resultType: 'continue', response: res }
  }
}
