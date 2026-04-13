import { NextResponse } from 'next/server'
import { callProxyTool, isPaymentRequired, getAccepts, pass, warn, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const SERVER_ID = 'test-echo-x402-coinbase'
const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'

async function ensureServerRegistered(proxyUrl: string, testClientUrl: string, recipient: string) {
  const res = await fetch(`${proxyUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: SERVER_ID,
      mcpOrigin: `${testClientUrl}/api/echo-mcp`,
      recipient: { stellar: { address: recipient, isTestnet: true } },
      paymentModes: ['x402-exact'],
      tools: [{ name: 'echo', pricing: '$0.0001' }],
    }),
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Registration failed (${res.status}): ${body}`)
  }
}

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const testClientUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3001'
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
  const secretKey = process.env.TEST_STELLAR_SECRET_KEY ?? ''
  const log: string[] = []

  if (!recipient || !secretKey) {
    const missing = [!recipient && 'TEST_RECIPIENT_ADDRESS', !secretKey && 'TEST_STELLAR_SECRET_KEY']
      .filter(Boolean).join(', ')
    return NextResponse.json(warn(
      `x402-Coinbase skipped — missing env vars: ${missing}`,
      [`Set the following in .env.local: ${missing}`],
      undefined,
      Date.now() - t0
    ))
  }

  try {
    log.push(`Step 1: Register echo server with x402-exact (id: ${SERVER_ID})`)
    await ensureServerRegistered(proxyUrl, testClientUrl, recipient)
    log.push('Server registered')

    log.push(`Step 2: Call tool without payment — expect payment_required`)
    const { result } = await callProxyTool(proxyUrl, SERVER_ID, 'echo', { text: 'test' })
    log.push(`isError: ${result.isError}`)

    if (!isPaymentRequired(result)) {
      log.push(`Full result: ${JSON.stringify(result)}`)
      return NextResponse.json(fail(
        'Expected payment_required but tool succeeded — x402ExactHook may not be active',
        log, result, Date.now() - t0
      ))
    }

    const accepts = getAccepts(result)
    const exactAccept = accepts.find(a => a.scheme === 'exact')
    log.push(`Payment required ✓`)

    if (!exactAccept) {
      return NextResponse.json(fail('payment_required returned but no exact scheme in accepts[]', log, accepts, Date.now() - t0))
    }

    const payTo = exactAccept.payTo as string
    log.push(`payTo: ${payTo}`)
    log.push(`maxAmountRequired: ${exactAccept.maxAmountRequired}`)

    // Dynamic imports — serverExternalPackages
    const { rpc, TransactionBuilder, BASE_FEE, Contract, nativeToScVal, Address, Networks, Keypair } =
      await import('@stellar/stellar-sdk')
    const { encodePaymentHeader } = await import('x402-stellar')

    log.push(`Step 3: Build and sign Soroban USDC SAC transfer transaction`)
    const keypair = Keypair.fromSecret(secretKey)
    log.push(`Source account: ${keypair.publicKey()}`)

    const server = new rpc.Server(SOROBAN_RPC_URL)
    const [account, latestLedger] = await Promise.all([
      server.getAccount(keypair.publicKey()),
      server.getLatestLedger(),
    ])
    log.push(`Account sequence: ${account.sequenceNumber()}`)

    const amount = BigInt(exactAccept.maxAmountRequired as string)
    log.push(`Payment amount: ${amount} stroops`)

    const contract = new Contract(USDC_TESTNET)
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(
        'transfer',
        Address.fromString(keypair.publicKey()).toScVal(),
        Address.fromString(payTo).toScVal(),
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

    const xPaymentHeader = encodePaymentHeader({
      x402Version: 1,
      scheme: 'exact',
      network: 'stellar-testnet',
      payload: {
        signedTxXdr,
        sourceAccount: keypair.publicKey(),
        amount: amount.toString(),
        destination: payTo,
        asset: USDC_TESTNET,
        validUntilLedger: latestLedger.sequence + 100,
        nonce: Date.now().toString(),
      },
    })
    log.push(`X-Payment header built (${xPaymentHeader.length} chars)`)

    log.push(`Step 4: Retry tool call WITH X-Payment header — proxy calls Coinbase facilitator`)
    const { result: paidResult } = await callProxyTool(
      proxyUrl, SERVER_ID, 'echo', { text: 'paid' },
      { 'X-Payment': xPaymentHeader }
    )
    log.push(`Paid call isError: ${paidResult.isError}`)
    log.push(`Content: ${JSON.stringify(paidResult.content)}`)

    if (paidResult.isError || isPaymentRequired(paidResult)) {
      log.push(`Full paid result: ${JSON.stringify(paidResult)}`)
      return NextResponse.json(fail(
        'Payment sent but tool still errored — check proxy FACILITATOR_URL and X402ExactHook',
        log, paidResult, Date.now() - t0
      ))
    }

    const text = paidResult.content?.[0]?.text ?? ''
    if (!text.startsWith('Echo:')) {
      return NextResponse.json(fail(`Unexpected echo response: ${text}`, log, paidResult, Date.now() - t0))
    }

    return NextResponse.json(pass(
      `x402 via Coinbase facilitator succeeded: "${text}"`,
      log,
      { response: text, amount: amount.toString(), payTo },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
