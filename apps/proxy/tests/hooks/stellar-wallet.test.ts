import { describe, it, expect, vi, beforeEach } from "vitest"
import { StellarWalletHook } from "../../src/lib/hooks/stellar-wallet-hook.js"

// Mock DB operations
vi.mock("../../src/lib/db/actions.js", () => ({
  walletOperations: {
    userHasStellarWallet: vi.fn().mockResolvedValue(true),
    getPrimaryStellarWallet: vi.fn().mockResolvedValue({
      walletAddress: "GABC123STELLAR0ADDRESS0TESTNET00000000000000000000000",
      provider: "stellar",
      walletMetadata: { network: "testnet" },
    }),
  },
}))

vi.mock("../../src/lib/db/stellar-wallet.js", () => ({
  createSponsoredStellarAccount: vi.fn().mockResolvedValue({
    address: "GNEW000SPONSORED0ACCOUNT0ADDRESS000000000000000000000",
    txHash: "mock-tx-hash",
  }),
}))

function makePaymentRequiredResult(scheme = "session"): any {
  return {
    isError: true,
    _meta: {
      "x402/error": {
        error: "PAYMENT_REQUIRED",
        accepts: [
          {
            scheme,
            network: "stellar:testnet",
            contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
            server: "GSERVER000000000000000000000000000000000000000000000000",
            pricePerCall: "1000000",
          },
        ],
      },
    },
    content: [{ type: "text", text: "{}" }],
  }
}

function makeSuccessResult(): any {
  return {
    isError: false,
    content: [{ type: "text", text: '{"city":"London","temp":18}' }],
  }
}

describe("StellarWalletHook", () => {
  const toolReq = { method: "tools/call", params: { name: "weather", arguments: {} } } as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("passes through non-payment results unchanged", async () => {
    const hook = new StellarWalletHook("user-123", "testnet")
    const result = await hook.processCallToolResult(makeSuccessResult(), toolReq, {} as any)
    expect(result.resultType).toBe("continue")
    expect((result as any).response.content[0].text).toContain("London")
  })

  it("returns continue when no userId (unauthenticated)", async () => {
    const hook = new StellarWalletHook(null, "testnet")
    const result = await hook.processCallToolResult(makePaymentRequiredResult(), toolReq, {} as any)
    expect(result.resultType).toBe("continue")
  })

  it("creates sponsored account when user has no wallet", async () => {
    const { walletOperations } = await import("../../src/lib/db/actions.js")
    const { createSponsoredStellarAccount } = await import("../../src/lib/db/stellar-wallet.js")

    vi.mocked(walletOperations.userHasStellarWallet).mockResolvedValueOnce(false)

    const hook = new StellarWalletHook("user-no-wallet", "testnet")
    await hook.processCallToolResult(makePaymentRequiredResult(), toolReq, {} as any)

    expect(createSponsoredStellarAccount).toHaveBeenCalledWith("user-no-wallet")
  })

  it("includes funding guidance for insufficient_funds error", async () => {
    const hook = new StellarWalletHook("user-123", "testnet")
    const insufficientResult: any = {
      isError: true,
      _meta: {
        "x402/error": {
          error: "INSUFFICIENT_FUNDS",
          accepts: [],
          payer: "GABC123STELLAR0ADDRESS0TESTNET00000000000000000000000",
        },
      },
      content: [{ type: "text", text: "{}" }],
    }

    const result = await hook.processCallToolResult(insufficientResult, toolReq, {} as any)
    expect(result.resultType).toBe("continue")
    const content = (result as any).response.content
    expect(content[0].text).toContain("Funding Required")
    expect(content[0].text).toContain("friendbot")
  })
})
