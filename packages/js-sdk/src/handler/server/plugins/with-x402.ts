import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { ZodRawShape } from 'zod'
import { useFacilitator, decodePaymentHeader } from 'x402-stellar'
import type { PaymentPayload, PaymentRequirements } from 'x402-stellar'
import type { StexioConfig, StellarNetwork } from '../../../types.js'
import { STELLAR_NETWORKS, USDC_DECIMALS } from '../../../types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map StellarNetwork to x402-stellar facilitator network string */
function toFacilitatorNetwork(network: StellarNetwork): 'stellar-testnet' | 'stellar' {
  return network === 'testnet' ? 'stellar-testnet' : 'stellar'
}

function priceToStroops(priceUSD: number): bigint {
  return BigInt(Math.round(priceUSD * Math.pow(10, USDC_DECIMALS)))
}

function parsePrice(price: number | string): number {
  if (typeof price === 'number') return price
  return parseFloat(price.replace('$', ''))
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface StexioAugmentedServer {
  paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    price: number | string,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): RegisteredTool
}

// ─── withX402 ─────────────────────────────────────────────────────────────────

/**
 * Augments an McpServer with a paidTool() method that gates tool execution
 * behind x402-exact Stellar payment verification.
 * Replaces withX402() from MCPay (EVM).
 */
export function withX402<S extends McpServer>(
  server: S,
  cfg: StexioConfig
): S & StexioAugmentedServer {
  const facilitatorUrl = cfg.facilitator?.url ?? 'https://www.x402.org/facilitator'
  const { verify, settle } = useFacilitator({ url: facilitatorUrl })
  const x402Version = cfg.version ?? 1

  const network: StellarNetwork = cfg.recipient.stellar.isTestnet ? 'testnet' : 'mainnet'
  const netConfig = STELLAR_NETWORKS[network]
  const recipientAddress = cfg.recipient.stellar.address

  function buildPaymentRequired(
    name: string,
    description: string,
    priceStroops: bigint,
    reason = 'PAYMENT_REQUIRED',
    extra: Record<string, unknown> = {}
  ): CallToolResult {
    const accepts: unknown[] = []

    if (cfg.paymentModes.includes('x402-exact')) {
      accepts.push({
        scheme: 'exact',
        network: toFacilitatorNetwork(network),
        maxAmountRequired: priceStroops.toString(),
        payTo: recipientAddress,
        asset: netConfig.usdc,
        maxTimeoutSeconds: 300,
        resource: `mcp://${name}`,
        mimeType: 'application/json',
        description,
      })
    }

    if (cfg.paymentModes.includes('x402-session') && cfg.sessionContractId) {
      accepts.push({
        scheme: 'session',
        network: netConfig.identifier,
        contractId: cfg.sessionContractId,
        server: recipientAddress,
        pricePerCall: priceStroops.toString(),
        token: netConfig.usdc,
        maxTimeoutSeconds: 300,
        resource: `mcp://${name}`,
        mimeType: 'application/json',
      })
    }

    const payload = { x402Version, error: reason, accepts, ...extra }
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      _meta: { 'x402/error': payload },
    }
  }

  function paidTool<Args extends ZodRawShape>(
    name: string,
    description: string,
    price: number | string,
    paramsSchema: Args,
    annotations: ToolAnnotations,
    cb: ToolCallback<Args>
  ): RegisteredTool {
    const priceUSD = parsePrice(price)
    const priceStroops = priceToStroops(priceUSD)

    return server.tool(
      name,
      description,
      paramsSchema,
      {
        ...annotations,
        paymentHint: true,
        paymentPriceUSD: priceUSD,
        paymentModes: cfg.paymentModes,
      },
      (async (args, extra) => {
        // Read payment token from _meta (injected by proxy or client)
        const metaToken = (extra?._meta as Record<string, unknown> | undefined)?.['x402/payment'] as string | undefined

        if (!metaToken) {
          return buildPaymentRequired(name, description, priceStroops)
        }

        // Determine scheme from decoded header
        let scheme: string | null = null
        try {
          const decoded = decodePaymentHeader<{ scheme?: string }>(metaToken)
          scheme = (decoded as { scheme?: string }).scheme ?? null
        } catch {
          return buildPaymentRequired(name, description, priceStroops, 'INVALID_PAYMENT')
        }

        // ── Exact mode: verify via x402-stellar facilitator ──────────────────

        if (scheme === 'exact') {
          try {
            const decoded = decodePaymentHeader<PaymentPayload>(metaToken)

            const requirement: PaymentRequirements = {
              scheme: 'exact',
              network: toFacilitatorNetwork(network),
              payTo: recipientAddress,
              asset: netConfig.usdc,
              maxAmountRequired: priceStroops.toString(),
              maxTimeoutSeconds: 300,
              resource: `mcp://${name}`,
              mimeType: 'application/json',
              description,
              outputSchema: null,
              extra: null,
            }

            const vr = await verify(decoded, requirement)
            if (!vr.isValid) {
              return buildPaymentRequired(name, description, priceStroops, vr.invalidReason ?? 'INVALID_PAYMENT')
            }

            // Execute tool, then settle
            let result: CallToolResult
            try {
              result = await (cb as ToolCallback<Args>)(args, extra)
            } catch (e) {
              return { isError: true, content: [{ type: 'text', text: String(e) }] }
            }

            if (!result.isError) {
              try {
                const s = await settle(decoded, requirement)
                if (s.success) {
                  result._meta = {
                    ...(result._meta ?? {}),
                    'x402/payment-response': { success: true, transaction: s.transaction },
                  }
                }
              } catch {
                // Settle failure is non-fatal — tool already executed
              }
            }

            return result
          } catch {
            return buildPaymentRequired(name, description, priceStroops, 'INVALID_PAYMENT')
          }
        }

        // ── Session mode: token present but verification handled by proxy ────

        if (scheme === 'session') {
          // Session verification is handled at the proxy layer (X402SessionHook).
          // If the token reaches here without a proxy, execute the tool directly.
          try {
            return await (cb as ToolCallback<Args>)(args, extra)
          } catch (e) {
            return { isError: true, content: [{ type: 'text', text: String(e) }] }
          }
        }

        return buildPaymentRequired(name, description, priceStroops, 'UNSUPPORTED_SCHEME')
      }) as ToolCallback<Args>
    )
  }

  Object.defineProperty(server, 'paidTool', {
    value: paidTool,
    writable: false,
    enumerable: false,
    configurable: true,
  })

  return server as S & StexioAugmentedServer
}
