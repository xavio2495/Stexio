import type { CallToolRequest, CallToolResult, Hook, RequestExtra } from "@stexio/js-sdk/handler"
import { walletOperations } from "../db/actions.js"
import { createSponsoredStellarAccount } from "../db/stellar-wallet.js"
import { signPaymentNonce, encodeSignature } from "x402-turbo-stellar"
import { Keypair } from "@stellar/stellar-sdk"
import { config } from "dotenv"

config()

// ─── Types ────────────────────────────────────────────────────────────────────

interface X402ErrorPayload {
  x402Version?: number
  error?: string
  accepts?: Array<{
    scheme: string
    network: string
    maxAmountRequired?: string
    payTo?: string
    asset?: string
    contractId?: string
    server?: string
    pricePerCall?: string
    maxTimeoutSeconds?: number
    resource?: string
    mimeType?: string
  }>
  payer?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPaymentErrorPayload(res: CallToolResult): X402ErrorPayload | null {
  const meta = (res?._meta as Record<string, unknown>) ?? {}
  const payload = meta["x402/error"] as X402ErrorPayload | undefined
  if (!payload?.error) return null

  const normalized = payload.error.toLowerCase()
  const paymentCodes = new Set([
    "payment_required",
    "invalid_payment",
    "unable_to_match_payment_requirements",
    "price_compute_failed",
    "insufficient_funds",
  ])
  return paymentCodes.has(normalized) ? payload : null
}

function withPaymentMeta(req: CallToolRequest, xPayment: string): CallToolRequest {
  const params = (req?.params ?? {}) as Record<string, unknown>
  const meta = (params["_meta"] as Record<string, unknown>) ?? {}
  return {
    method: "tools/call" as const,
    params: {
      ...params,
      _meta: { ...meta, "x402/payment": xPayment },
    },
  } as unknown as CallToolRequest
}

/**
 * Build a funding guidance message for users who have insufficient USDC.
 * Replaces MCPay's Coinbase onramp URL generation.
 */
function buildFundingMessage(walletAddress: string, network: "testnet" | "mainnet"): string {
  const stellarExpertUrl = `https://stellar.expert/explorer/${network}/account/${walletAddress}`

  if (network === "testnet") {
    return [
      "## Funding Required\n",
      "Your Stellar wallet needs USDC to make payments.\n",
      `• **Your wallet**: \`${walletAddress}\``,
      `• **View on Stellar Expert**: [${walletAddress.slice(0, 8)}...](${stellarExpertUrl})`,
      `• **Get testnet XLM**: https://friendbot.stellar.org?addr=${walletAddress}`,
      "• **Get testnet USDC**: Use [Stellar Lab](https://laboratory.stellar.org) — add USDC trustline, then fund from testnet issuer",
      "\n---\n",
      "## Payment Details",
    ].join("\n")
  }

  return [
    "## Funding Required\n",
    "Your Stellar wallet needs USDC to make payments.\n",
    `• **Your wallet**: \`${walletAddress}\``,
    `• **View on Stellar Expert**: [${walletAddress.slice(0, 8)}...](${stellarExpertUrl})`,
    "• **Get USDC**: Use an exchange or [MoneyGram ramp](https://developers.stellar.org/docs/tools/ramps/moneygram)",
    "\n---\n",
    "## Payment Details",
  ].join("\n")
}

// ─── Payment Signing ──────────────────────────────────────────────────────────

/**
 * Sign a session payment using the server keypair on behalf of the user.
 *
 * Strategy: For managed/sponsored accounts (agent/CLI users) the proxy
 * server's keypair signs the payment nonce from STELLAR_SERVER_SECRET_KEY.
 * Browser users (Freighter) sign in the frontend — this hook returns null
 * for those cases and lets the user handle it.
 *
 * Note: exact scheme requires wallet-side signing (Freighter) — not supported here.
 */
async function signPaymentForUser(
  userId: string,
  accept: NonNullable<X402ErrorPayload["accepts"]>[number],
  network: "testnet" | "mainnet",
): Promise<{ signedPaymentHeader: string; scheme: string } | null> {
  try {
    const wallet = await walletOperations.getPrimaryStellarWallet(userId)
    if (!wallet?.walletAddress) return null

    // For managed/sponsored accounts: use server-side signing
    // In production this would use the user's encrypted key from secure storage.
    // For hackathon demo: use the server's keypair as proxy payer.
    const serverSecretKey = process.env.STELLAR_SERVER_SECRET_KEY
    if (!serverSecretKey) {
      console.warn("[StellarWalletHook] STELLAR_SERVER_SECRET_KEY not set — cannot auto-sign")
      return null
    }

    const signerKeypair = Keypair.fromSecret(serverSecretKey)
    const contractId = process.env.SESSION_CONTRACT_ID

    if (accept.scheme === "session" && contractId && accept.server) {
      // Sign x402-turbo session payment nonce.
      // Use nonce 1 for first auto-pay (in production, track per-channel nonce).
      const nonce = 1n
      const amount = BigInt(accept.pricePerCall ?? "1000000")
      const sig = signPaymentNonce(
        signerKeypair,
        contractId,
        signerKeypair.publicKey(),
        accept.server,
        nonce,
        amount,
      )

      const header = Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: "session",
          network: accept.network,
          payload: {
            client: signerKeypair.publicKey(),
            server: accept.server,
            contractId,
            nonce: nonce.toString(),
            cumulativeAmount: amount.toString(),
            signature: encodeSignature(sig),
          },
        }),
      ).toString("base64")

      return { signedPaymentHeader: header, scheme: "session" }
    }

    if (accept.scheme === "exact") {
      // Exact mode requires Freighter or similar — not auto-signable server-side.
      console.info("[StellarWalletHook] Exact mode requires wallet signing — skipping auto-pay")
      return null
    }

    return null
  } catch (err) {
    console.error("[StellarWalletHook] Sign error:", err)
    return null
  }
}

// ─── StellarWalletHook ────────────────────────────────────────────────────────

export class StellarWalletHook implements Hook {
  name = "stellar-wallet"

  constructor(
    private readonly userId: string | null,
    private readonly network: "testnet" | "mainnet" = "testnet",
  ) {}

  async processCallToolRequest(req: CallToolRequest, _extra: RequestExtra) {
    // No-op on the way in — we only act on 402 responses
    return { resultType: "continue" as const, request: req }
  }

  async processCallToolResult(res: CallToolResult, req: CallToolRequest, _extra: RequestExtra) {
    try {
      const payload = getPaymentErrorPayload(res)
      if (!payload) {
        return { resultType: "continue" as const, response: res }
      }

      // Handle insufficient_funds — provide funding guidance
      if (payload.error?.toLowerCase() === "insufficient_funds") {
        return this.handleInsufficientFunds(res, payload)
      }

      // Must have an authenticated user to auto-pay
      if (!this.userId) {
        return { resultType: "continue" as const, response: res }
      }

      // Get first accepted payment requirement (prefer session over exact)
      const accepts = payload.accepts ?? []
      const preferredAccept =
        accepts.find((a) => a.scheme === "session") ??
        accepts.find((a) => a.scheme === "exact") ??
        accepts[0]

      if (!preferredAccept) {
        return { resultType: "continue" as const, response: res }
      }

      // Ensure user has a Stellar wallet — create sponsored account if not
      const hasWallet = await walletOperations.userHasStellarWallet(this.userId)
      if (!hasWallet) {
        console.log(
          `[StellarWalletHook] No Stellar wallet for user ${this.userId} — creating sponsored account`,
        )
        try {
          await createSponsoredStellarAccount(this.userId)
        } catch (err) {
          console.warn("[StellarWalletHook] Sponsored account creation failed:", err)
          return { resultType: "continue" as const, response: res }
        }
      }

      // Attempt to sign the payment
      const signed = await signPaymentForUser(this.userId, preferredAccept, this.network)
      if (!signed) {
        return { resultType: "continue" as const, response: res }
      }

      // Retry the original tool call with the signed payment header
      console.log(
        `[StellarWalletHook] Auto-signed ${signed.scheme} payment for user ${this.userId.slice(0, 8)}`,
      )
      return { resultType: "retry" as const, request: withPaymentMeta(req, signed.signedPaymentHeader) }
    } catch (err) {
      console.error("[StellarWalletHook] Error:", err)
      return { resultType: "continue" as const, response: res }
    }
  }

  private handleInsufficientFunds(
    res: CallToolResult,
    payload: X402ErrorPayload,
  ) {
    const walletAddress = (payload.payer as string | undefined) ?? "your-stellar-address"
    const fundingMessage = buildFundingMessage(walletAddress, this.network)

    const enhancedContent = [
      { type: "text" as const, text: fundingMessage },
      ...(Array.isArray(res.content) ? res.content : []),
    ]

    return {
      resultType: "continue" as const,
      response: { ...res, content: enhancedContent },
    }
  }
}
