/**
 * x402 via Stellar facilitator — direct client test.
 *
 * Tests the x402-stellar package's useFacilitator client directly from the test client,
 * without routing through the proxy. This validates the facilitator HTTP API integration
 * and the Soroban tx signing flow independently.
 *
 * Flow:
 *   1. Build + sign Soroban USDC SAC transfer tx
 *   2. Encode as x402 payment header
 *   3. Call facilitator.verify() directly
 *   4. If valid, call facilitator.settle()
 *   5. Report facilitator response
 */
import { NextResponse } from 'next/server'
import { warn, fail, pass } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'
import type { PaymentRequirements } from 'x402-stellar'

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
const PRICE_STROOPS = '1000'   // 0.0001 USDC

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
  const secretKey = process.env.TEST_STELLAR_SECRET_KEY ?? ''
  const facilitatorUrl = process.env.FACILITATOR_URL ?? 'https://x402.org/facilitator'
  const log: string[] = []

  if (!recipient || !secretKey) {
    const missing = [!recipient && 'TEST_RECIPIENT_ADDRESS', !secretKey && 'TEST_STELLAR_SECRET_KEY']
      .filter(Boolean).join(', ')
    return NextResponse.json(warn(
      `x402-Stellar direct skipped — missing env vars: ${missing}`,
      [`Set the following in .env.local: ${missing}`],
      undefined,
      Date.now() - t0
    ))
  }

  try {
    const { rpc, TransactionBuilder, BASE_FEE, Contract, nativeToScVal, Address, Networks, Keypair } =
      await import('@stellar/stellar-sdk')
    const { encodePaymentHeader, decodePaymentHeader, useFacilitator } = await import('x402-stellar')

    log.push(`Step 1: Build Soroban USDC SAC transfer transaction`)
    const keypair = Keypair.fromSecret(secretKey)
    log.push(`Source: ${keypair.publicKey()}`)
    log.push(`Destination: ${recipient}`)

    const server = new rpc.Server(SOROBAN_RPC_URL)
    const [account, latestLedger] = await Promise.all([
      server.getAccount(keypair.publicKey()),
      server.getLatestLedger(),
    ])
    log.push(`Latest ledger: ${latestLedger.sequence}`)

    const amount = BigInt(PRICE_STROOPS)
    const contract = new Contract(USDC_TESTNET)
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(
        'transfer',
        Address.fromString(keypair.publicKey()).toScVal(),
        Address.fromString(recipient).toScVal(),
        nativeToScVal(amount, { type: 'i128' }),
      ))
      .setTimeout(300)
      .build()

    log.push(`Simulating transaction...`)
    const simResult = await server.simulateTransaction(tx)

    if (rpc.Api.isSimulationError(simResult)) {
      const errMsg = simResult.error ?? 'Simulation failed'
      log.push(`Simulation error: ${errMsg}`)
      return NextResponse.json(fail(
        `Soroban simulation failed — ensure account is funded with USDC on testnet: ${errMsg}`,
        log, simResult, Date.now() - t0
      ))
    }

    const prepared = rpc.assembleTransaction(tx, simResult).build()
    prepared.sign(keypair)
    const signedTxXdr = prepared.toEnvelope().toXDR('base64')
    log.push(`Transaction signed (XDR length: ${signedTxXdr.length})`)

    log.push(`Step 2: Encode x402 payment header`)
    const xPaymentHeader = encodePaymentHeader({
      x402Version: 1,
      scheme: 'exact',
      network: 'stellar-testnet',
      payload: {
        signedTxXdr,
        sourceAccount: keypair.publicKey(),
        amount: amount.toString(),
        destination: recipient,
        asset: USDC_TESTNET,
        validUntilLedger: latestLedger.sequence + 100,
        nonce: Date.now().toString(),
      } as never,
    })
    log.push(`X-Payment header built (${xPaymentHeader.length} chars)`)

    log.push(`Step 3: Call facilitator.verify() directly at ${facilitatorUrl}`)
    const { verify, settle } = useFacilitator({ url: facilitatorUrl })

    const decoded = decodePaymentHeader(xPaymentHeader)

    const requirements: PaymentRequirements = {
      scheme: 'exact',
      network: 'stellar-testnet',
      payTo: recipient,
      asset: USDC_TESTNET,
      maxAmountRequired: PRICE_STROOPS,
      maxTimeoutSeconds: 300,
      resource: '',
      description: 'direct facilitator test',
      mimeType: 'application/json',
      outputSchema: null,
      extra: null,
    }

    const vr = await verify(decoded as Parameters<typeof verify>[0], requirements)
    log.push(`Facilitator verify: isValid=${vr.isValid}`)
    if (!vr.isValid) {
      log.push(`Invalid reason: ${vr.invalidReason ?? 'unknown'}`)
      return NextResponse.json(fail(
        `Facilitator rejected payment: ${vr.invalidReason ?? 'unknown'}`,
        log, vr, Date.now() - t0
      ))
    }

    log.push(`Step 4: Call facilitator.settle()`)
    const sr = await settle(decoded as Parameters<typeof settle>[0], requirements)
    log.push(`Settle success: ${sr.success}`)
    if (sr.success) {
      log.push(`Transaction hash: ${sr.transaction ?? 'n/a'}`)
    } else {
      log.push(`Settle error: ${sr.errorReason ?? 'unknown'}`)
    }

    if (!sr.success) {
      return NextResponse.json(fail(
        `Facilitator settle failed: ${sr.errorReason ?? 'unknown'}`,
        log, sr, Date.now() - t0
      ))
    }

    return NextResponse.json(pass(
      `x402 via Stellar facilitator: verify ✓ settle ✓ tx=${sr.transaction ?? 'n/a'}`,
      log,
      { isValid: vr.isValid, transaction: sr.transaction },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
