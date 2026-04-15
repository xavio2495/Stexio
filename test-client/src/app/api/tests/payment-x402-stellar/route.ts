/**
 * x402 via Stellar facilitator — REAL direct client test
 *
 * Uses the official Coinbase Channels facilitator with proper Bearer token auth.
 * Uses x402/stellar client library to properly construct payment payloads.
 *
 * Reference: https://developers.stellar.org/docs/build/agentic-payments/x402/built-on-stellar
 */
import { NextResponse } from 'next/server'
import { warn, fail, pass } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
const PRICE_STROOPS = '1000'   // 0.0001 USDC

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
  const secretKey = process.env.TEST_STELLAR_SECRET_KEY ?? ''
  const facilitatorUrl = (process.env.FACILITATOR_URL ?? 'https://channels.openzeppelin.com/x402/testnet').replace(/\/$/, '')
  const facilitatorApiKey = process.env.FACILITATOR_API_KEY ?? ''
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

  if (!facilitatorApiKey) {
    return NextResponse.json(warn(
      `x402-Stellar direct skipped — FACILITATOR_API_KEY not set`,
      [
        `Generate a new API key from:`,
        `   Testnet: https://channels.openzeppelin.com/testnet/gen`,
        `   Mainnet: https://channels.openzeppelin.com/gen`,
        `Then set FACILITATOR_API_KEY in .env.local`
      ],
      undefined,
      Date.now() - t0
    ))
  }

  try {
    const { rpc, TransactionBuilder, BASE_FEE, Contract, nativeToScVal, Address, Networks, Keypair } =
      await import('@stellar/stellar-sdk')
    const { x402Client } = await import('@x402/core/client')
    const { ExactStellarScheme } = await import('@x402/stellar/exact/client')
    const { createEd25519Signer } = await import('@x402/stellar')

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
    log.push(`Transaction signed`)

    log.push(`Step 2: Create payment payload via x402 client library`)

    // Create x402 client with Stellar exact scheme
    const client = new x402Client()
    const stellarSigner = createEd25519Signer(secretKey, 'stellar:testnet')
    client.register('stellar:*', new ExactStellarScheme(stellarSigner, { url: SOROBAN_RPC_URL }))

    // Build payment requirements matching facilitator's /supported response
    const paymentRequired = {
      x402Version: 2,
      resource: { url: new URL(facilitatorUrl).href },
      accepts: [{
        scheme: 'exact' as const,
        network: 'stellar:testnet' as const,
        payTo: recipient,
        amount: amount.toString(),
        asset: USDC_TESTNET,
        maxTimeoutSeconds: 300,
        extra: {
          areFeesSponsored: true,  // ← Required by facilitator
        },
      }],
    }

    log.push(`Creating payment payload via x402 client...`)
    const paymentPayload = await client.createPaymentPayload(paymentRequired)
    log.push(`Payment payload created (version: ${paymentPayload.x402Version})`)

    // Also construct paymentRequirements for facilitator endpoint
    const paymentRequirements = paymentPayload.accepted

    log.push(`Step 3: POST /verify with facilitator Bearer auth`)

    const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${facilitatorApiKey}`,
      },
      body: JSON.stringify({
        paymentPayload,
        paymentRequirements,
      }),
    })

    const verifyBody = await verifyRes.json()
    log.push(`Facilitator verify: status=${verifyRes.status} ok=${verifyRes.ok}`)
    log.push(`Response: ${JSON.stringify(verifyBody)}`)

    if (!verifyRes.ok || !verifyBody.isValid) {
      return NextResponse.json(fail(
        `Facilitator verify failed: ${verifyBody.invalidReason || verifyBody.error || 'unknown'}`,
        log, verifyBody, Date.now() - t0
      ))
    }

    log.push(`Facilitator verify: isValid ✓`)

    log.push(`Step 4: POST /settle with facilitator Bearer auth`)

    const settleRes = await fetch(`${facilitatorUrl}/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${facilitatorApiKey}`,
      },
      body: JSON.stringify({
        paymentPayload,
        paymentRequirements,
      }),
    })

    const settleBody = await settleRes.json()
    log.push(`Facilitator settle: status=${settleRes.status} ok=${settleRes.ok}`)
    log.push(`Response: ${JSON.stringify(settleBody)}`)

    if (!settleRes.ok || !settleBody.success) {
      return NextResponse.json(fail(
        `Facilitator settle failed: ${settleBody.errorReason || settleBody.error || 'unknown'}`,
        log, settleBody, Date.now() - t0
      ))
    }

    log.push(`Facilitator settle: success ✓`)
    log.push(`Transaction hash: ${settleBody.transaction}`)

    return NextResponse.json(pass(
      `x402 via Stellar facilitator: verify ✓ settle ✓ tx=${settleBody.transaction}`,
      log,
      {
        isValid: verifyBody.isValid,
        transaction: settleBody.transaction,
        settled: settleBody.success,
      },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    if (err instanceof Error) {
      log.push(`Stack: ${err.stack?.split('\n').slice(0, 3).join('\n')}`)
    }
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
