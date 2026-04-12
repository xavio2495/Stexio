import { describe, it, expect } from "vitest"
import { Keypair } from "@stellar/stellar-sdk"
import { X402SessionHook } from "../../src/lib/hooks/x402-hook.js"
import { signPaymentNonce, encodeSignature } from "x402-turbo-stellar"

const SERVER_KP = Keypair.random()
const CLIENT_KP = Keypair.random()
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"

const BASE_SESSION_CONFIG = {
  contractId: CONTRACT_ID,
  serverKeypair: SERVER_KP,
  network: "testnet" as const,
  pricePerCall: 1_000_000n,
  batchSize: 100,       // don't auto-flush during tests
  batchIntervalMs: 999_999, // don't auto-flush during tests
}

function buildSessionHeader(nonce: bigint, cumulative: bigint): string {
  const sig = signPaymentNonce(
    CLIENT_KP,
    CONTRACT_ID,
    CLIENT_KP.publicKey(),
    SERVER_KP.publicKey(),
    nonce,
    cumulative,
  )
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "session",
      network: "stellar:testnet",
      payload: {
        client: CLIENT_KP.publicKey(),
        server: SERVER_KP.publicKey(),
        contractId: CONTRACT_ID,
        nonce: nonce.toString(),
        cumulativeAmount: cumulative.toString(),
        signature: encodeSignature(sig),
      },
    }),
  ).toString("base64")
}

function makePaymentRequiredResult(): CallToolResult {
  return {
    isError: true,
    _meta: { "x402/error": { error: "PAYMENT_REQUIRED", accepts: [] } },
    content: [{ type: "text", text: "{}" }],
  }
}

// Minimal CallToolResult type for this file
type CallToolResult = {
  isError?: boolean
  _meta?: Record<string, unknown>
  content: Array<{ type: string; text: string }>
}

describe("X402SessionHook", () => {
  it("accepts valid session payment and returns retry", async () => {
    const hook = new X402SessionHook(BASE_SESSION_CONFIG)
    const header = buildSessionHeader(1n, 1_000_000n)

    const result = await hook.processCallToolResult(
      makePaymentRequiredResult() as any,
      { method: "tools/call", params: { name: "weather", arguments: {} } } as any,
      { requestId: "test-1", inboundHeaders: new Headers({ "X-Payment": header }) } as any,
    )

    expect(result.resultType).toBe("retry")
    hook.destroy()
  })

  it("rejects invalid signature and returns continue", async () => {
    const hook = new X402SessionHook(BASE_SESSION_CONFIG)
    const wrongKp = Keypair.random()
    // Sign with wrong keypair — signature won't match CLIENT_KP
    const sig = signPaymentNonce(
      wrongKp,
      CONTRACT_ID,
      CLIENT_KP.publicKey(),
      SERVER_KP.publicKey(),
      1n,
      1_000_000n,
    )
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: "session",
        network: "stellar:testnet",
        payload: {
          client: CLIENT_KP.publicKey(),
          server: SERVER_KP.publicKey(),
          contractId: CONTRACT_ID,
          nonce: "1",
          cumulativeAmount: "1000000",
          signature: encodeSignature(sig),
        },
      }),
    ).toString("base64")

    const result = await hook.processCallToolResult(
      makePaymentRequiredResult() as any,
      { method: "tools/call", params: { name: "weather", arguments: {} } } as any,
      { requestId: "test-2", inboundHeaders: new Headers({ "X-Payment": header }) } as any,
    )

    expect(result.resultType).toBe("continue")
    hook.destroy()
  })

  it("passes through non-payment results unchanged", async () => {
    const hook = new X402SessionHook(BASE_SESSION_CONFIG)
    const successResult = {
      isError: false,
      content: [{ type: "text", text: "sunny in London" }],
    }

    const result = await hook.processCallToolResult(
      successResult as any,
      { method: "tools/call", params: { name: "weather", arguments: {} } } as any,
      { requestId: "test-3" } as any,
    )

    expect(result.resultType).toBe("continue")
    hook.destroy()
  })
})
