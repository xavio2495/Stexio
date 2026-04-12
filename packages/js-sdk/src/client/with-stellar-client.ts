import type { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolRequest,
  CallToolResult,
  CallToolResultSchema,
  CompatibilityCallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Keypair } from '@stellar/stellar-sdk'
import { signPaymentNonce, encodeSignature } from 'x402-turbo-stellar'
import type { StellarNetwork, PaymentMode } from '../types.js'
import { STELLAR_NETWORKS } from '../types.js'

export interface StellarClientConfig {
  wallet: {
    stellar: Keypair
  }
  paymentModes: PaymentMode[]
  network: StellarNetwork
  /** Max payment in stroops before refusing. Default: 10_000_000 (1 USDC) */
  maxPaymentValue?: bigint
  sessionConfig?: {
    contractId: string
    depositAmount?: bigint
    maxNonce?: bigint
  }
  confirmationCallback?: (accepts: unknown[]) => Promise<boolean | number>
}

export interface StellarAugmentedClient {
  callTool(
    params: CallToolRequest['params'],
    resultSchema?: typeof CallToolResultSchema | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ): Promise<CallToolResult>
}

/**
 * Wraps an MCP client with Stellar payment capabilities.
 * Supports x402-exact and x402-session payment modes.
 * Replaces withX402Client from MCPay.
 */
export function withStellarClient<T extends MCPClient>(
  client: T,
  config: StellarClientConfig
): StellarAugmentedClient & T {
  const keypair = config.wallet.stellar
  const maxPaymentValue = config.maxPaymentValue ?? 10_000_000n
  const netConfig = STELLAR_NETWORKS[config.network]

  const _callTool = client.callTool.bind(client)

  const callToolWithPayment = async (
    params: CallToolRequest['params'],
    resultSchema?: typeof CallToolResultSchema | typeof CompatibilityCallToolResultSchema,
    options?: RequestOptions
  ): ReturnType<typeof client.callTool> => {
    // First call — attempt without payment
    const res = await _callTool(params, resultSchema, options)

    // Check if payment is required
    const maybeError = res._meta?.['x402/error'] as {
      accepts?: Array<{ scheme: string; network: string; [key: string]: unknown }>
    } | undefined

    if (!res.isError || !maybeError?.accepts?.length) {
      return res
    }

    const accepts = maybeError.accepts

    // Optional confirmation callback
    if (config.confirmationCallback) {
      const approved = await config.confirmationCallback(accepts)
      if (approved === false) {
        return { isError: true, content: [{ type: 'text', text: 'User declined payment' }] }
      }
    }

    // Pick the best payment mode — session preferred over exact
    const sessionAccept = config.paymentModes.includes('x402-session')
      ? accepts.find(a => a.scheme === 'session')
      : undefined

    const exactAccept = config.paymentModes.includes('x402-exact')
      ? accepts.find(a => a.scheme === 'exact')
      : undefined

    // ── Session mode ──────────────────────────────────────────────────────────

    if (sessionAccept && config.sessionConfig) {
      const pricePerCall = BigInt(
        (sessionAccept['pricePerCall'] as string | undefined) ?? '1000000'
      )

      if (pricePerCall > maxPaymentValue) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Payment exceeds cap: ${pricePerCall} > ${maxPaymentValue}` }],
        }
      }

      const serverAddress = sessionAccept['server'] as string
      const contractId = (sessionAccept['contractId'] as string | undefined) ?? config.sessionConfig.contractId

      // Nonce = 1n for hackathon (production: track per-channel nonce in Redis)
      const nonce = 1n
      const sig = signPaymentNonce(
        keypair,
        contractId,
        keypair.publicKey(),
        serverAddress,
        nonce,
        pricePerCall,
      )

      const paymentHeader = Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: 'session',
          network: netConfig.identifier,
          payload: {
            client: keypair.publicKey(),
            server: serverAddress,
            contractId,
            nonce: nonce.toString(),
            cumulativeAmount: pricePerCall.toString(),
            signature: encodeSignature(sig),
          },
        })
      ).toString('base64')

      return _callTool(
        {
          ...params,
          _meta: { ...(params._meta ?? {}), 'x402/payment': paymentHeader },
        },
        resultSchema,
        options,
      )
    }

    // ── Exact mode ────────────────────────────────────────────────────────────

    if (exactAccept) {
      const amount = BigInt((exactAccept['maxAmountRequired'] as string | undefined) ?? '0')
      if (amount > maxPaymentValue) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Payment exceeds cap: ${amount} > ${maxPaymentValue}` }],
        }
      }

      // Exact mode requires wallet signing (e.g., Freighter) — return 402 for the app to handle
      console.info('[withStellarClient] Exact mode: payment header must be signed by wallet (Freighter)')
      return res
    }

    return res
  }

  const augmented = client as StellarAugmentedClient & T
  Object.defineProperty(augmented, 'callTool', {
    value: callToolWithPayment,
    writable: false,
    enumerable: false,
    configurable: true,
  })

  return augmented
}
