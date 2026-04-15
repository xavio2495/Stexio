/**
 * MPP Session — voucher credential via one-way-channel Soroban contract.
 *
 * Full real verification requires:
 *   - A deployed one-way-channel Soroban contract (TEST_MPP_CHANNEL_ADDRESS / MPP_CHANNEL_ADDRESS on proxy)
 *   - The Ed25519 commitment keypair (TEST_COMMITMENT_SECRET in test client, COMMITMENT_PUBKEY on proxy)
 *
 * If those are not configured: test warns and exits early.
 * See resources/mpp_session_guide.md for deployment instructions.
 *
 * When fully configured, the flow is:
 *  1. Register echo server with mpp-session + channel address
 *  2. Call without credential → get mppx channel challenge
 *  3. Simulate prepare_commitment on Soroban contract
 *  4. Sign commitment bytes with Ed25519 commitment key
 *  5. Build mppx channel credential and retry
 */
import { NextResponse } from 'next/server'
import { callProxyTool, isPaymentRequired, getMppRequirements, pass, warn, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const SERVER_ID = 'test-echo-mpp-session'
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'

async function ensureServerRegistered(
  proxyUrl: string, testClientUrl: string, recipient: string, channelAddress: string
) {
  await fetch(`${proxyUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: SERVER_ID,
      mcpOrigin: `${testClientUrl}/api/echo-mcp`,
      recipient: { stellar: { address: recipient, isTestnet: true } },
      paymentModes: ['mpp-session'],
      tools: [{ name: 'echo', pricing: '$0.0001' }],
      metadata: { channelAddress },
    }),
    cache: 'no-store',
  })
}

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const testClientUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3001'
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
  const channelAddress = process.env.TEST_MPP_CHANNEL_ADDRESS ?? ''
  const commitmentSecret = process.env.TEST_COMMITMENT_SECRET ?? ''
  const log: string[] = []

  if (!recipient) {
    return NextResponse.json(warn(
      'MPP Session skipped — TEST_RECIPIENT_ADDRESS not set',
      ['Set TEST_RECIPIENT_ADDRESS in .env.local'],
      undefined,
      Date.now() - t0
    ))
  }

  // Full real test requires deployed channel contract + commitment keypair
  if (!channelAddress || !commitmentSecret) {
    const missing = [!channelAddress && 'TEST_MPP_CHANNEL_ADDRESS', !commitmentSecret && 'TEST_COMMITMENT_SECRET']
      .filter(Boolean).join(', ')
    return NextResponse.json(warn(
      `MPP Session skipped — missing: ${missing}`,
      [
        `Set ${missing} in .env.local`,
        'Also set MPP_CHANNEL_ADDRESS + COMMITMENT_PUBKEY on the proxy',
        'See resources/mpp_session_guide.md for one-way-channel contract deployment',
      ],
      undefined,
      Date.now() - t0
    ))
  }

  try {
    log.push(`Step 1: Register echo server with mpp-session (id: ${SERVER_ID})`)
    log.push(`Channel: ${channelAddress}`)
    await ensureServerRegistered(proxyUrl, testClientUrl, recipient, channelAddress)
    log.push('Server registered')

    log.push(`Step 2: Call tool WITHOUT credential — expect payment_required with mppx channel challenge`)
    const { result: firstResult } = await callProxyTool(proxyUrl, SERVER_ID, 'echo', { text: 'mpp session test' })
    log.push(`isError: ${firstResult.isError}`)

    if (!isPaymentRequired(firstResult)) {
      log.push(`Full result: ${JSON.stringify(firstResult)}`)
      return NextResponse.json(fail(
        'Expected payment_required — MppHook may not be active (check MPP_SECRET_KEY + MPP_CHANNEL_ADDRESS on proxy)',
        log, firstResult, Date.now() - t0
      ))
    }
    log.push('Payment required ✓')

    const mppReqs = getMppRequirements(firstResult)
    log.push(`MPP requirements: ${JSON.stringify(mppReqs)}`)

    const wwwAuthenticate = mppReqs?.wwwAuthenticate as string | undefined
    if (!wwwAuthenticate) {
      return NextResponse.json(fail(
        'No wwwAuthenticate in MPP requirements — proxy may be missing MPP_SECRET_KEY or COMMITMENT_PUBKEY',
        log, mppReqs, Date.now() - t0
      ))
    }
    log.push(`Challenge: ${wwwAuthenticate.slice(0, 80)}...`)

    // Step 3: Parse mppx challenge
    log.push(`Step 3: Parse mppx channel challenge`)
    const { Challenge, Credential } = await import('mppx')
    const challenge = Challenge.deserialize(wwwAuthenticate)
    log.push(`Challenge id: ${challenge.id.slice(0, 16)}... method: ${challenge.method}`)

    // Step 4: Simulate prepare_commitment on Soroban + sign with Ed25519 commitment key
    log.push(`Step 4: Simulate prepare_commitment and sign with commitment key`)
    const {
      rpc,
      Contract,
      Keypair,
      xdr,
      nativeToScVal,
      TransactionBuilder,
      BASE_FEE,
      Networks,
    } = await import('@stellar/stellar-sdk')

    // Derive commitment keypair from raw hex secret (64 chars = 32 bytes)
    // The secret format from hex is a raw Ed25519 seed, convert to Stellar Keypair
    const secretBuffer = Buffer.from(commitmentSecret, 'hex')
    const commitmentKey = Keypair.fromRawEd25519Seed(secretBuffer)
    log.push(`Commitment public key: ${commitmentKey.publicKey()}`)

    const server = new rpc.Server(SOROBAN_RPC_URL)
    const requestData = challenge.request as Record<string, unknown>
    const cumulativeAmount = BigInt(String(requestData.amount ?? '1000'))

    // Simulate prepare_commitment to get commitment bytes
    log.push(`Simulating prepare_commitment(${cumulativeAmount})...`)

    const contract = new Contract(channelAddress)
    const amountScVal = nativeToScVal(cumulativeAmount, { type: 'i128' })

    let signatureHex = ''

    // Build and simulate prepare_commitment call
    try {
      // Use recipient account as source (from mpp requirements, not challenge)
      const recipientAddress = mppReqs?.payTo as string | undefined
      if (!recipientAddress) throw new Error('No payTo in mpp requirements')

      // Use live account with actual sequence for realistic Soroban simulation
      const sourceAccount = await server.getAccount(recipientAddress)
      const simTx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: 'Test SDF Network ; September 2015',
      })
        .setTimeout(30)
        .addOperation(
          contract.call('prepare_commitment', amountScVal)
        )
        .build()

      const simResult = await server.simulateTransaction(simTx)

      let commitmentBytes: Buffer | null = null

      if (simResult.result?.retval) {
        // Extract bytes from simulation result
        const retval = simResult.result.retval
        if (retval.bytes && typeof retval.bytes === 'function') {
          try {
            // .bytes() returns Uint8Array directly — use it as-is
            const bytesResult = retval.bytes()
            commitmentBytes = Buffer.from(bytesResult)
            log.push(`Got commitment bytes from contract (${commitmentBytes.length} bytes): ${commitmentBytes.toString('hex').slice(0, 32)}...`)
          } catch (e) {
            log.push(`Could not extract bytes: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      // If no bytes from contract, that's a real error—don't fall back
      if (!commitmentBytes) {
        throw new Error('Contract did not return commitment bytes—simulation returned ' + JSON.stringify(simResult.result?.retval?.type))
      }

      const signature = commitmentKey.sign(commitmentBytes)
      signatureHex = Buffer.from(signature).toString('hex')
      log.push(`Commitment signed (cumulative: ${cumulativeAmount}, sig: ${signatureHex.slice(0, 16)}...)`)

    } catch (simErr) {
      // Simulation error is fatal—we need actual commitment bytes from the contract
      const msg = simErr instanceof Error ? simErr.message : String(simErr)
      log.push(`Fatal: Simulation failed and no fallback possible — ${msg}`)
      throw simErr
    }

    // Step 5: Build mppx channel credential
    log.push(`Step 5: Build mppx channel credential`)
    const authHeader = Credential.serialize({
      challenge,
      payload: {
        action: 'voucher',
        amount: cumulativeAmount.toString(),
        signature: signatureHex,
      },
    })
    log.push(`Authorization header built (${authHeader.length} chars)`)
    log.push(`Payload: action=voucher, amount=${cumulativeAmount}, sig=${signatureHex.slice(0, 16)}...`)

    // Step 6: Retry with credential
    log.push(`Step 6: Retry tool call with Authorization: Payment ... (channel voucher)`)
    const { result: paidResult } = await callProxyTool(
      proxyUrl, SERVER_ID, 'echo', { text: 'mpp session test' },
      { 'Authorization': authHeader }
    )
    log.push(`Paid call isError: ${paidResult.isError}`)
    log.push(`Content: ${JSON.stringify(paidResult.content)}`)

    if (paidResult.isError || isPaymentRequired(paidResult)) {
      log.push(`Full paid result: ${JSON.stringify(paidResult)}`)
      return NextResponse.json(fail(
        'MPP channel voucher sent but tool returned error — check proxy logs and channel contract',
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
      `MPP Session: channel voucher verified — "${text}"`,
      log,
      { response: text, receipt, channelAddress },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
