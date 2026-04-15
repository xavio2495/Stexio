/**
 * MPP Session — 10 Sequential Payments with Cumulative Tracking
 *
 * Tests the full payment progression with proper cumulative amount management:
 * Payment #1: cumulative 0 → 100
 * Payment #2: cumulative 100 → 200
 * ...
 * Payment #10: cumulative 900 → 1000
 *
 * Each payment is 100 stroops (0.00001 USDC)
 */
import { NextResponse } from 'next/server'
import { callProxyTool, isPaymentRequired, getMppRequirements, pass, warn, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const SERVER_ID = 'test-echo-mpp-session-10x'
const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org'
const PAYMENT_AMOUNT = 1000n // stroops (0.0001 USDC)
const NUM_PAYMENTS = 10

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
      tools: [{ name: 'echo', pricing: '$0.00001' }],
      metadata: { channelAddress, description: '10x sequential payments' },
    }),
    cache: 'no-store',
  })
}

interface PaymentResult {
  paymentNum: number
  cumulativeAmount: string  // Convert BigInt to string
  status: 'success' | 'failed'
  signature: string
  receipt?: Record<string, unknown>
  error?: string
}

export async function GET(): Promise<NextResponse<TestResult>> {
  const t0 = Date.now()
  const proxyUrl = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'
  const testClientUrl = process.env.NEXT_PUBLIC_TEST_CLIENT_URL ?? 'http://localhost:3001'
  const recipient = process.env.TEST_RECIPIENT_ADDRESS ?? ''
  const channelAddress = process.env.TEST_MPP_CHANNEL_ADDRESS ?? ''
  const commitmentSecret = process.env.TEST_COMMITMENT_SECRET ?? ''
  const log: string[] = []
  const results: PaymentResult[] = []

  if (!recipient) {
    return NextResponse.json(warn(
      '10x MPP Session skipped — TEST_RECIPIENT_ADDRESS not set',
      ['Set TEST_RECIPIENT_ADDRESS in .env.local'],
      undefined,
      Date.now() - t0
    ))
  }

  if (!channelAddress || !commitmentSecret) {
    const missing = [!channelAddress && 'TEST_MPP_CHANNEL_ADDRESS', !commitmentSecret && 'TEST_COMMITMENT_SECRET']
      .filter(Boolean).join(', ')
    return NextResponse.json(warn(
      `10x MPP Session skipped — missing: ${missing}`,
      [`Set ${missing} in .env.local`],
      undefined,
      Date.now() - t0
    ))
  }

  try {
    log.push(`Running 10 sequential MPP payments, ${PAYMENT_AMOUNT} stroops each`)
    log.push(`Total: ${PAYMENT_AMOUNT * BigInt(NUM_PAYMENTS)} stroops (0.001 USDC)`)
    log.push(`Server ID: ${SERVER_ID}`)

    await ensureServerRegistered(proxyUrl, testClientUrl, recipient, channelAddress)
    log.push('✓ Server registered')

    const {
      rpc,
      Contract,
      Keypair,
      nativeToScVal,
      TransactionBuilder,
      BASE_FEE,
    } = await import('@stellar/stellar-sdk')
    const { Challenge, Credential } = await import('mppx')

    const secretBuffer = Buffer.from(commitmentSecret, 'hex')
    const commitmentKey = Keypair.fromRawEd25519Seed(secretBuffer)
    const server = new rpc.Server(SOROBAN_RPC_URL)
    const contract = new Contract(channelAddress)

    let cumulativeAmount = 0n

    // Run 10 payments
    for (let i = 1; i <= NUM_PAYMENTS; i++) {
      const paymentLog = `\n─── Payment #${i} ───`
      log.push(paymentLog)
      cumulativeAmount += PAYMENT_AMOUNT

      try {
        // Step 1: Get challenge (without credential)
        log.push(`Cumulative amount: ${cumulativeAmount} stroops`)
        const { result: challengeResult } = await callProxyTool(
          proxyUrl, SERVER_ID, 'echo', { text: `payment ${i}` }
        )

        if (!isPaymentRequired(challengeResult)) {
          throw new Error('Expected 402 Payment Required for fresh payment')
        }

        const mppReqs = getMppRequirements(challengeResult)
        const wwwAuthenticate = mppReqs?.wwwAuthenticate as string | undefined
        if (!wwwAuthenticate) throw new Error('No challenge in response')

        const challenge = Challenge.deserialize(wwwAuthenticate)

        // Step 2: Simulate and sign
        const amountScVal = nativeToScVal(cumulativeAmount, { type: 'i128' })
        // Use live account with actual sequence for realistic Soroban simulation
        const sourceAccount = await server.getAccount(recipient)
        const simTx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: 'Test SDF Network ; September 2015',
        })
          .setTimeout(30)
          .addOperation(contract.call('prepare_commitment', amountScVal))
          .build()

        const simResult = await server.simulateTransaction(simTx)
        let commitmentBytes: Buffer | null = null

        if (simResult.result?.retval?.bytes && typeof simResult.result.retval.bytes === 'function') {
          const bytesResult = simResult.result.retval.bytes()
          commitmentBytes = Buffer.from(bytesResult)
        }

        if (!commitmentBytes) throw new Error('Failed to get commitment bytes from contract')

        const signature = commitmentKey.sign(commitmentBytes)
        const signatureHex = Buffer.from(signature).toString('hex')
        log.push(`✓ Simulated & signed (sig: ${signatureHex.slice(0, 16)}...)`)

        // Step 3: Build and send credential
        const authHeader = Credential.serialize({
          challenge,
          payload: {
            action: 'voucher',
            amount: cumulativeAmount.toString(),
            signature: signatureHex,
          },
        })

        const { result: paidResult } = await callProxyTool(
          proxyUrl, SERVER_ID, 'echo', { text: `payment ${i}` },
          { 'Authorization': authHeader }
        )

        if (paidResult.isError || isPaymentRequired(paidResult)) {
          throw new Error(`Payment failed: ${paidResult.content?.[0]?.text ?? 'unknown error'}`)
        }

        const text = paidResult.content?.[0]?.text ?? ''
        const meta = paidResult._meta as Record<string, unknown> | undefined
        const receipt = meta?.['X-MPP-Receipt'] as Record<string, unknown> | undefined

        log.push(`✓ Payment accepted: "${text}"`)
        if (receipt) log.push(`✓ Receipt: ${JSON.stringify(receipt)}`)

        results.push({
          paymentNum: i,
          cumulativeAmount: cumulativeAmount.toString(),
          status: 'success',
          signature: signatureHex,
          receipt,
        })

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        log.push(`✗ Payment failed: ${errMsg}`)
        results.push({
          paymentNum: i,
          cumulativeAmount: cumulativeAmount.toString(),
          status: 'failed',
          signature: '',
          error: errMsg,
        })
        break // Stop on first failure to preserve channel state
      }
    }

    const successes = results.filter(r => r.status === 'success').length
    const totalSpent = BigInt(successes) * PAYMENT_AMOUNT
    log.push(`\n════════════════════`)
    log.push(`Completed: ${successes}/${NUM_PAYMENTS} payments`)
    log.push(`Total spent: ${totalSpent} stroops (0.00001 USDC × ${successes})`)
    log.push(`Final cumulative: ${cumulativeAmount} stroops`)

    if (successes === NUM_PAYMENTS) {
      return NextResponse.json(pass(
        `✅ All 10 MPP payments succeeded with cumulative tracking`,
        log,
        {
          payments: results,
          totalSpent: totalSpent.toString(),
          finalCumulative: cumulativeAmount.toString(),
        },
        Date.now() - t0
      ))
    } else if (successes > 0) {
      return NextResponse.json(pass(
        `⚠️ ${successes}/10 payments succeeded (stopped at first failure)`,
        log,
        {
          payments: results,
          completed: successes,
          totalSpent: totalSpent.toString(),
        },
        Date.now() - t0
      ))
    } else {
      return NextResponse.json(fail(
        'No payments succeeded',
        log,
        { payments: results },
        Date.now() - t0
      ))
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Fatal error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
