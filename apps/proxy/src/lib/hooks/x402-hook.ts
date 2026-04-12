import type { CallToolRequest, CallToolResult, Hook, RequestExtra } from "@stexio/js-sdk/handler"
import { useFacilitator, decodePaymentHeader } from "x402-stellar"
import type { PaymentPayload, PaymentRequirements } from "x402-stellar"
import {
  verifyPaymentSignature,
  decodeSignature,
  STELLAR_TESTNET_CONFIG,
  STELLAR_MAINNET_CONFIG,
  submitClaim,
} from "x402-turbo-stellar"
import type { StellarNetwork } from "x402-turbo-stellar"
import { Keypair } from "@stellar/stellar-sdk"

// ─── Types ────────────────────────────────────────────────────────────────────

/** Generic X-Payment header wrapper — scheme field determines routing */
interface X402Header {
  x402Version: number
  scheme: string
  network: string
  payload: Record<string, unknown>
}

/** Session-specific payload from X-Payment header (x402-turbo-stellar) */
interface SessionPayload {
  client: string
  server: string
  contractId: string
  nonce: string | number
  cumulativeAmount: string | number
  signature: string
}

interface PendingClaim {
  clientAddress: string
  cumulativeAmount: bigint
  nonce: bigint
  signature: Buffer
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPaymentRequiredResponse(res: CallToolResult): boolean {
  const meta = (res?._meta as Record<string, unknown>) ?? {}
  const payload = meta["x402/error"] as { error?: string } | undefined
  if (!payload?.error) return false
  return ["payment_required", "invalid_payment", "unable_to_match_payment_requirements"].includes(
    payload.error.toLowerCase(),
  )
}

function parseXPaymentHeader(header: string): X402Header | null {
  try {
    return decodePaymentHeader<X402Header>(header)
  } catch {
    return null
  }
}

/** Map our 'testnet'|'mainnet' to x402-stellar facilitator network string */
function toFacilitatorNetwork(network: StellarNetwork): "stellar-testnet" | "stellar" {
  return network === "testnet" ? "stellar-testnet" : "stellar"
}

/** Map our 'testnet'|'mainnet' to x402-turbo network string for 402 response bodies */
function toNetworkId(network: StellarNetwork): string {
  return network === "testnet" ? "stellar:testnet" : "stellar:pubnet"
}

function getUsdcContractId(network: StellarNetwork): string {
  return network === "testnet"
    ? STELLAR_TESTNET_CONFIG.usdcContractId
    : STELLAR_MAINNET_CONFIG.usdcContractId
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

// ─── X402ExactHook ────────────────────────────────────────────────────────────

export interface X402ExactConfig {
  recipientAddress: string
  facilitatorUrl: string
  network: StellarNetwork
  pricePerCall: number // USD, e.g. 0.001
}

export class X402ExactHook implements Hook {
  name = "x402-exact"
  private readonly verify: ReturnType<typeof useFacilitator>["verify"]
  private readonly settle: ReturnType<typeof useFacilitator>["settle"]

  constructor(private readonly cfg: X402ExactConfig) {
    const { verify, settle } = useFacilitator({ url: cfg.facilitatorUrl })
    this.verify = verify
    this.settle = settle
  }

  async processCallToolRequest(req: CallToolRequest, _extra: RequestExtra) {
    return { resultType: "continue" as const, request: req }
  }

  async processCallToolResult(res: CallToolResult, req: CallToolRequest, extra: RequestExtra) {
    if (!isPaymentRequiredResponse(res)) {
      return { resultType: "continue" as const, response: res }
    }

    const xPayment = extra.inboundHeaders?.get("X-Payment")
    if (!xPayment) return { resultType: "continue" as const, response: res }

    const parsed = parseXPaymentHeader(xPayment)
    if (!parsed || parsed.scheme !== "exact") {
      return { resultType: "continue" as const, response: res }
    }

    try {
      const decoded = decodePaymentHeader<PaymentPayload>(xPayment)
      const priceInStroops = Math.round(this.cfg.pricePerCall * 10_000_000).toString()

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: toFacilitatorNetwork(this.cfg.network),
        payTo: this.cfg.recipientAddress,
        asset: getUsdcContractId(this.cfg.network),
        maxAmountRequired: priceInStroops,
        maxTimeoutSeconds: 300,
        resource: "",
        description: "",
        mimeType: "application/json",
        outputSchema: null,
        extra: null,
      }

      const vr = await this.verify(decoded, requirement)
      if (!vr.isValid) {
        console.warn("[X402ExactHook] Payment invalid:", vr.invalidReason)
        return { resultType: "continue" as const, response: res }
      }

      const sr = await this.settle(decoded, requirement)
      if (!sr.success) {
        console.warn("[X402ExactHook] Settlement failed:", sr.errorReason)
        return { resultType: "continue" as const, response: res }
      }

      console.log("[X402ExactHook] Payment settled tx:", sr.transaction)
      return { resultType: "retry" as const, request: withPaymentMeta(req, xPayment) }
    } catch (err) {
      console.error("[X402ExactHook] Error:", err)
      return { resultType: "continue" as const, response: res }
    }
  }
}

// ─── X402SessionHook ──────────────────────────────────────────────────────────

export interface X402SessionConfig {
  contractId: string
  serverKeypair: Keypair
  network: StellarNetwork
  pricePerCall: bigint // in stroops
  batchSize?: number
  batchIntervalMs?: number
}

export class X402SessionHook implements Hook {
  name = "x402-session"
  private readonly pendingClaims = new Map<string, PendingClaim>()
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly cfg: X402SessionConfig) {
    const intervalMs = cfg.batchIntervalMs ?? 30_000
    this.flushTimer = setInterval(() => {
      void this.flushClaims()
    }, intervalMs)
  }

  async processCallToolRequest(req: CallToolRequest, _extra: RequestExtra) {
    return { resultType: "continue" as const, request: req }
  }

  async processCallToolResult(res: CallToolResult, req: CallToolRequest, extra: RequestExtra) {
    if (!isPaymentRequiredResponse(res)) {
      return { resultType: "continue" as const, response: res }
    }

    const xPayment = extra.inboundHeaders?.get("X-Payment")
    if (!xPayment) return { resultType: "continue" as const, response: res }

    const parsed = parseXPaymentHeader(xPayment)
    if (!parsed || parsed.scheme !== "session") {
      return { resultType: "continue" as const, response: res }
    }

    const p = parsed.payload as unknown as SessionPayload

    try {
      // Server and contract must match our config
      if (p.server !== this.cfg.serverKeypair.publicKey()) {
        console.warn("[X402SessionHook] Server address mismatch")
        return { resultType: "continue" as const, response: res }
      }
      if (p.contractId !== this.cfg.contractId) {
        console.warn("[X402SessionHook] Contract ID mismatch")
        return { resultType: "continue" as const, response: res }
      }

      const nonce = BigInt(p.nonce)
      const cumulativeAmount = BigInt(p.cumulativeAmount)

      // Price integrity: cumulativeAmount must cover nonce * pricePerCall
      if (cumulativeAmount < nonce * this.cfg.pricePerCall) {
        console.warn("[X402SessionHook] Insufficient cumulative amount")
        return { resultType: "continue" as const, response: res }
      }

      // Verify Ed25519 signature locally (no network call)
      const sigBuffer = decodeSignature(p.signature)
      const valid = verifyPaymentSignature(
        p.client,
        p.contractId,
        p.client,
        p.server,
        nonce,
        cumulativeAmount,
        sigBuffer,
      )
      if (!valid) {
        console.warn("[X402SessionHook] Invalid signature for client:", p.client.slice(0, 8))
        return { resultType: "continue" as const, response: res }
      }

      // Queue latest claim — higher nonce supersedes
      const existing = this.pendingClaims.get(p.client)
      if (!existing || nonce > existing.nonce) {
        this.pendingClaims.set(p.client, {
          clientAddress: p.client,
          cumulativeAmount,
          nonce,
          signature: sigBuffer,
        })
      }

      if (this.pendingClaims.size >= (this.cfg.batchSize ?? 10)) {
        void this.flushClaims()
      }

      return { resultType: "retry" as const, request: withPaymentMeta(req, xPayment) }
    } catch (err) {
      console.error("[X402SessionHook] Error:", err)
      return { resultType: "continue" as const, response: res }
    }
  }

  private async flushClaims(): Promise<void> {
    if (this.pendingClaims.size === 0) return

    const claims = [...this.pendingClaims.values()]
    this.pendingClaims.clear()

    for (const claim of claims) {
      try {
        const result = await submitClaim({
          serverKeypair: this.cfg.serverKeypair,
          clientAddress: claim.clientAddress,
          contractId: this.cfg.contractId,
          network: this.cfg.network,
          cumulativeAmount: claim.cumulativeAmount,
          nonce: claim.nonce,
          signature: claim.signature,
        })
        console.log(
          "[X402SessionHook] Claim submitted tx:",
          result.txHash,
          "amount:",
          result.amountClaimed.toString(),
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Permanent contract errors: discard. Transient errors: re-queue.
        if (msg.includes("HostError: Error(Contract,")) {
          console.error("[X402SessionHook] Permanent claim error for", claim.clientAddress.slice(0, 8), msg)
        } else {
          console.warn("[X402SessionHook] Transient claim error, re-queuing", claim.clientAddress.slice(0, 8))
          this.pendingClaims.set(claim.clientAddress, claim)
        }
      }
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }
}
