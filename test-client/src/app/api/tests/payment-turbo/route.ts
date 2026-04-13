import { NextResponse } from 'next/server'
import { callProxyTool, isPaymentRequired, getAccepts, pass, warn, fail } from '@/lib/mcp-utils'
import type { TestResult } from '@/lib/types'

const SERVER_ID = 'test-echo-turbo'

async function ensureServerRegistered(
  proxyUrl: string,
  testClientUrl: string,
  recipient: string,
  sessionContractId: string,
) {
  await fetch(`${proxyUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: SERVER_ID,
      mcpOrigin: `${testClientUrl}/api/echo-mcp`,
      recipient: { stellar: { address: recipient, isTestnet: true } },
      paymentModes: ['x402-session'],
      sessionContractId,
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
  const contractId = process.env.TEST_SESSION_CONTRACT_ID ?? ''
  const log: string[] = []

  if (!recipient || !secretKey || !contractId) {
    const missing = [
      !recipient && 'TEST_RECIPIENT_ADDRESS',
      !secretKey && 'TEST_STELLAR_SECRET_KEY',
      !contractId && 'TEST_SESSION_CONTRACT_ID',
    ].filter(Boolean).join(', ')
    return NextResponse.json(warn(
      `x402-turbo-stellar skipped — missing env vars: ${missing}`,
      [`Set the following in .env.local: ${missing}`],
      undefined,
      Date.now() - t0
    ))
  }

  const { Keypair } = await import('@stellar/stellar-sdk')
  const { signPaymentNonce, encodeSignature } = await import('x402-turbo-stellar')

  try {
    log.push(`Step 1: Register echo server with x402-session (id: ${SERVER_ID})`)
    await ensureServerRegistered(proxyUrl, testClientUrl, recipient, contractId)
    log.push('Server registered')

    log.push(`Step 2: Call tool WITHOUT payment — expect payment_required with session accept`)
    const { result: firstResult } = await callProxyTool(proxyUrl, SERVER_ID, 'echo', { text: 'turbo test' })
    log.push(`isError: ${firstResult.isError}`)

    if (!isPaymentRequired(firstResult)) {
      log.push(`Full result: ${JSON.stringify(firstResult)}`)
      return NextResponse.json(fail(
        'Expected payment_required but tool succeeded — x402SessionHook may not be active. Check STELLAR_SERVER_SECRET_KEY in proxy env.',
        log, firstResult, Date.now() - t0
      ))
    }

    const accepts = getAccepts(firstResult)
    const sessionAccept = accepts.find(a => a.scheme === 'session')
    log.push(`Payment required ✓, session accept found: ${!!sessionAccept}`)

    if (!sessionAccept) {
      log.push(`Accepts: ${JSON.stringify(accepts)}`)
      return NextResponse.json(fail(
        'No session scheme in accepts[]. Ensure proxy has SESSION_CONTRACT_ID and STELLAR_SERVER_SECRET_KEY set.',
        log, { accepts }, Date.now() - t0
      ))
    }

    const serverAddress = sessionAccept.server as string
    const acceptedContractId = sessionAccept.contractId as string
    const pricePerCall = BigInt((sessionAccept.pricePerCall as string | undefined) ?? '1000')
    log.push(`Server address: ${serverAddress}`)
    log.push(`Contract: ${acceptedContractId}`)
    log.push(`Price per call: ${pricePerCall} stroops`)

    log.push(`Step 3: Sign session payment nonce`)
    const keypair = Keypair.fromSecret(secretKey)
    const clientAddress = keypair.publicKey()
    const nonce = 1n
    const cumulativeAmount = pricePerCall

    log.push(`Client address: ${clientAddress}`)
    const sig = signPaymentNonce(keypair, acceptedContractId, clientAddress, serverAddress, nonce, cumulativeAmount)
    const encodedSig = encodeSignature(sig)

    const paymentPayload = {
      x402Version: 1,
      scheme: 'session',
      network: 'stellar:testnet',
      payload: {
        client: clientAddress,
        server: serverAddress,
        contractId: acceptedContractId,
        nonce: nonce.toString(),
        cumulativeAmount: cumulativeAmount.toString(),
        signature: encodedSig,
      },
    }
    const xPaymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')
    log.push(`X-Payment header built (${xPaymentHeader.length} chars)`)

    log.push(`Step 4: Retry tool call WITH X-Payment header`)
    const { result: paidResult } = await callProxyTool(
      proxyUrl, SERVER_ID, 'echo', { text: 'turbo test' },
      { 'X-Payment': xPaymentHeader }
    )
    log.push(`Paid call isError: ${paidResult.isError}`)
    log.push(`Content: ${JSON.stringify(paidResult.content)}`)

    if (paidResult.isError || isPaymentRequired(paidResult)) {
      log.push(`Full paid result: ${JSON.stringify(paidResult)}`)
      return NextResponse.json(fail(
        'Payment was sent but tool still returned an error — verify proxy STELLAR_SERVER_SECRET_KEY matches TEST_SERVER_STELLAR_ADDRESS',
        log, paidResult, Date.now() - t0
      ))
    }

    const text = paidResult.content?.[0]?.text ?? ''
    if (!text.startsWith('Echo:')) {
      return NextResponse.json(fail(`Unexpected echo response: ${text}`, log, paidResult, Date.now() - t0))
    }

    return NextResponse.json(pass(
      `x402-turbo-stellar round-trip succeeded: "${text}"`,
      log,
      { response: text },
      Date.now() - t0
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.push(`Error: ${msg}`)
    return NextResponse.json(fail(msg, log, undefined, Date.now() - t0))
  }
}
