#!/usr/bin/env node

import { Command } from 'commander'
import { config } from 'dotenv'
import packageJson from '../../package.json' with { type: 'json' }
import { startStdioServer, ServerType } from '../server/stdio/start-stdio-server.js'
import type { StellarClientConfig } from '../client/with-stellar-client.js'
import { createStellarSigner } from '../utils/signer.js'
import type { StellarNetwork, PaymentMode } from '../types.js'

config()

interface ConnectOptions {
  urls: string
  apiKey?: string
  stellar?: string
  stellarNetwork?: string
  paymentMode?: string
  sessionContract?: string
  maxPayment?: string
}

const program = new Command()

program
  .name('stexio')
  .description('Stexio CLI — paid MCP servers on Stellar')
  .version(packageJson.version)

program
  .command('connect')
  .description('Connect to one or more paid MCP servers via stdio')
  .requiredOption('-u, --urls <urls>', 'Comma-separated list of MCP server URLs')
  .option('-a, --api-key <key>', 'Stexio API key (from stexio.xyz). Env: API_KEY')
  .option(
    '--stellar <secretKey>',
    'Stellar secret key S... for direct payment signing. Env: STELLAR_SECRET_KEY'
  )
  .option(
    '--stellar-network <network>',
    'Stellar network: testnet | mainnet (default: testnet). Env: STELLAR_NETWORK'
  )
  .option(
    '--payment-mode <mode>',
    'Payment mode: exact | session | mpp (default: exact). Env: PAYMENT_MODE'
  )
  .option(
    '--session-contract <id>',
    'SessionChannel contract ID C... (required for session mode). Env: SESSION_CONTRACT_ID'
  )
  .option(
    '--max-payment <stroops>',
    'Max payment in stroops (default: 10000000 = 1 USDC). Env: MAX_PAYMENT_STROOPS'
  )
  .action(async (options: ConnectOptions) => {
    try {
      const apiKey = options.apiKey ?? process.env.API_KEY
      const stellarSecretKey = options.stellar ?? process.env.STELLAR_SECRET_KEY
      const networkStr = (
        options.stellarNetwork ??
        process.env.STELLAR_NETWORK ??
        'testnet'
      ).toLowerCase()
      const sessionContractId = options.sessionContract ?? process.env.SESSION_CONTRACT_ID
      const maxPaymentStr =
        options.maxPayment ?? process.env.MAX_PAYMENT_STROOPS ?? '10000000'

      // Validate network
      if (networkStr !== 'testnet' && networkStr !== 'mainnet') {
        console.error(
          `Error: Invalid stellar-network '${networkStr}'. Use 'testnet' or 'mainnet'.`
        )
        process.exit(1)
      }
      const network = networkStr as StellarNetwork

      // Must have either API key or Stellar key
      if (!apiKey && !stellarSecretKey) {
        console.error('Error: Provide either --api-key or --stellar <secretKey>')
        console.error('  --api-key: Use your Stexio API key for proxy-authenticated payment')
        console.error('  --stellar: Use a Stellar secret key for direct payment signing')
        process.exit(1)
      }

      // Determine payment modes
      const paymentModeFlag = options.paymentMode ?? process.env.PAYMENT_MODE
      let paymentModes: PaymentMode[] = ['x402-exact']
      if (paymentModeFlag) {
        switch (paymentModeFlag) {
          case 'exact':
            paymentModes = ['x402-exact']
            break
          case 'session':
            paymentModes = ['x402-session']
            if (!sessionContractId) {
              console.error('Error: --session-contract is required for session mode')
              process.exit(1)
            }
            break
          case 'mpp':
            paymentModes = ['mpp-charge']
            break
          default:
            console.error(
              `Error: Unknown payment-mode '${paymentModeFlag}'. Use: exact | session | mpp`
            )
            process.exit(1)
        }
      } else if (sessionContractId) {
        // Auto-prefer session if contract is provided
        paymentModes = ['x402-session', 'x402-exact']
      }

      // Parse server URLs
      const serverUrls = options.urls
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean)
      if (serverUrls.length === 0) {
        console.error('Error: At least one server URL is required')
        process.exit(1)
      }

      console.log(`[stexio] Connecting to ${serverUrls.length} server(s)`)
      console.log(`[stexio] Network: Stellar ${network}`)
      console.log(`[stexio] Payment modes: ${paymentModes.join(', ')}`)

      // Build Stellar client config if using a secret key directly
      let stellarClientConfig: StellarClientConfig | undefined
      if (stellarSecretKey) {
        const keypair = createStellarSigner(stellarSecretKey)
        console.log(`[stexio] Wallet: ${keypair.publicKey().slice(0, 8)}...`)
        stellarClientConfig = {
          wallet: { stellar: keypair },
          paymentModes,
          network,
          maxPaymentValue: BigInt(maxPaymentStr),
          sessionConfig: sessionContractId
            ? {
                contractId: sessionContractId,
                depositAmount: 10_000_000n,
                maxNonce: 1000n,
              }
            : undefined,
        }
      }

      // Start stdio server — connects to all provided URLs
      await startStdioServer({
        serverConnections: serverUrls.map((url) => ({
          url,
          serverType: ServerType.HTTPStream,
        })),
        stellarClientConfig,
        apiKey,
      })
    } catch (err) {
      console.error('[stexio] Fatal error:', err)
      process.exit(1)
    }
  })

program.parse(process.argv)
