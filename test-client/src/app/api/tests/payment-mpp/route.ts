/**
 * MPP Charge — real on-chain payment via mppx + @stellar/mpp.
 *
 * Flow:
 *  1. Register echo server with mpp-charge payment mode
 *  2. Call tool without credential → proxy returns payment_required with mppx challenge
 *     (WWW-Authenticate header value embedded in _meta['x402/error'].mpp.wwwAuthenticate)
 *  3. Parse the challenge with Challenge.deserialize (mppx)
 *  4. Build Soroban USDC SAC transfer tx and sign it
 *  5. Build mppx credential: { challenge, payload: { type: "transaction", transaction: xdr } }
 *  6. Serialize credential and retry with Authorization: Payment <base64> header
 *  7. Proxy verifies via @stellar/mpp (Soroban simulation + broadcast) → returns success
 */
import { NextResponse } from 'next/server'
import { callProxyTool, isPaymentRequired, getMppRequirements, pass, warn, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const SERVER_ID = 'test-echo-mpp'
const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'

async function ensureServerRegistered(proxyUrl: string, testClientUrl: string, recipient: string) {
  await fetch(`${proxyUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: SERVER_ID,
      mcpOrigin: `${testClientUrl}/api/echo-mcp`,
      recipient: { stellar: { address: recipient, isTestnet: true } },
      paymentModes: ['mpp-charge'],
      tools: [{ name: 'echo', pricing: '$0.0001' }],
    }),
    cache: 'no-store',
  })
}

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const testClientUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3001'
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
  const secretKey = process.env.TEST_STELLAR_SECRET_KEY ?? ''
  const log: string[] = []

  const missing = [!recipient && 'TEST_RECIPIENT_ADDRESS', !secretKey && 'TEST_STELLAR_SECRET_KEY']
    .filter(Boolean).join(', ')
  if (missing) {
    return NextResponse.json(warn(
      `MPP Charge skipped — missing env vars: ${missing}`,
      [`Set the following in .env.local: ${missing}`],
      undefined,
      Date.now() - t0
    ))
  }

  try {
    log.push(`Step 1: Register echo server with mpp-charge (id: ${SERVER_ID})`)
    await ensureServerRegistered(proxyUrl, testClientUrl, recipient)
    log.push('Server registered')

    log.push(`Step 2: Call tool WITHOUT credential — expect payment_required with mppx challenge`)
    const { result: firstResult } = await callProxyTool(proxyUrl, SERVER_ID, 'echo', { text: 'mpp test' })
    log.push(`isError: ${firstResult.isError}`)

    if (!isPaymentRequired(firstResult)) {
      log.push(`Full result: ${JSON.stringify(firstResult)}`)
      return NextResponse.json(fail(
        'Expected payment_required — MppHook may not be active (check MPP_SECRET_KEY on proxy)',
        log, firstResult, Date.now() - t0
      ))
    }
    log.push('Payment required ✓')

    const mppReqs = getMppRequirements(firstResult)
    log.push(`MPP requirements: ${JSON.stringify(mppReqs)}`)

    const wwwAuthenticate = mppReqs?.wwwAuthenticate as string | undefined
    if (!wwwAuthenticate) {
      return NextResponse.json(fail(
        'No wwwAuthenticate field in MPP requirements — proxy is running old mppx or MPP_SECRET_KEY missing',
        log, mppReqs, Date.now() - t0
      ))
    }
    log.push(`Challenge: ${wwwAuthenticate.slice(0, 80)}...`)

    // Step 3: Parse mppx challenge
    log.push(`Step 3: Parse mppx challenge`)
    const { Challenge, Credential } = await import('mppx')
    const challenge = Challenge.deserialize(wwwAuthenticate)
    log.push(`Challenge id: ${challenge.id.slice(0, 16)}... realm: ${challenge.realm}`)
    log.push(`Challenge method: ${challenge.method} intent: ${challenge.intent}`)

    // Step 4: Build Soroban USDC SAC transfer tx
    log.push(`Step 4: Build and sign Soroban USDC SAC transfer tx`)
    const {
      rpc, TransactionBuilder, BASE_FEE, Contract, nativeToScVal, Address, Networks, Keypair,
    } = await import('@stellar/stellar-sdk')

    const keypair = Keypair.fromSecret(secretKey)
    log.push(`Source: ${keypair.publicKey()}`)
    log.push(`Destination: ${recipient}`)

    const server = new rpc.Server(SOROBAN_RPC_URL)
    const [account, latestLedger] = await Promise.all([
      server.getAccount(keypair.publicKey()),
      server.getLatestLedger(),
    ])
    log.push(`Latest ledger: ${latestLedger.sequence}`)

    // Amount from challenge request (already in base units)
    const requestData = challenge.request as Record<string, unknown>
    const amountBaseUnits = BigInt(String(requestData.amount ?? '1000'))
    log.push(`Amount (base units): ${amountBaseUnits}`)

    // @stellar/mpp verifies: tx.timeBounds.maxTime must NOT exceed challenge.expires.
    // setTimeout(300) sets maxTime = now+300, which always exceeds the challenge expiry
    // (also ~300s from issuance). Use challenge.expires directly as maxTime instead.
    const challengeExpiresUnix = Math.floor(new Date(challenge.expires as string).getTime() / 1000)
    const contract = new Contract(USDC_TESTNET)
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: 0, maxTime: challengeExpiresUnix },
    })
      .addOperation(contract.call(
        'transfer',
        Address.fromString(keypair.publicKey()).toScVal(),
        Address.fromString(recipient).toScVal(),
        nativeToScVal(amountBaseUnits, { type: 'i128' }),
      ))
      .build()

    log.push(`Simulating transaction...`)
    const simResult = await server.simulateTransaction(tx)

    if (rpc.Api.isSimulationError(simResult)) {
      const errMsg = simResult.error ?? 'Simulation failed'
      log.push(`Simulation error: ${errMsg}`)
      return NextResponse.json(fail(
        `Soroban simulation failed — ensure account has USDC on testnet: ${errMsg}`,
        log, simResult, Date.now() - t0
      ))
    }

    const prepared = rpc.assembleTransaction(tx, simResult).build()
    prepared.sign(keypair)
    const signedTxXdr = prepared.toEnvelope().toXDR('base64')
    log.push(`Tx signed (XDR length: ${signedTxXdr.length})`)

    // Step 5: Build mppx credential
    log.push(`Step 5: Build mppx credential`)
    const authHeader = Credential.serialize({
      challenge,
      payload: { type: 'transaction', transaction: signedTxXdr },
      source: `did:pkh:stellar:testnet:${keypair.publicKey()}`,
    })
    log.push(`Authorization header built (${authHeader.length} chars)`)

    // Step 6: Retry with Authorization header
    log.push(`Step 6: Retry tool call with Authorization: Payment ...`)
    const { result: paidResult } = await callProxyTool(
      proxyUrl, SERVER_ID, 'echo', { text: 'mpp test' },
      { 'Authorization': authHeader }
    )
    log.push(`Paid call isError: ${paidResult.isError}`)
    log.push(`Content: ${JSON.stringify(paidResult.content)}`)

    if (paidResult.isError || isPaymentRequired(paidResult)) {
      log.push(`Full paid result: ${JSON.stringify(paidResult)}`)
      return NextResponse.json(fail(
        'MPP credential sent but tool still returned an error — check proxy logs for [stellar:charge] errors',
        log, paidResult, Date.now() - t0
      ))
    }

    const text = paidResult.content?.[0]?.text ?? ''
    if (!text.startsWith('Echo:')) {
      return NextResponse.json(fail(`Unexpected echo response: ${text}`, log, paidResult, Date.now() - t0))
    }

    const meta = paidResult._meta as Record<string, unknown> | undefined
    const receipt = meta?.['X-MPP-Receipt']
    log.push(`MPP receipt: ${JSON.stringify(receipt ?? 'none')}`)

    return NextResponse.json(pass(
      `MPP Charge: real Soroban SAC tx verified and broadcast — "${text}"`,
      log,
      { response: text, receipt, challengeId: challenge.id.slice(0, 16) },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
