import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk"
import { walletOperations } from "./actions.js"
import { config } from "dotenv"

config()

const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org"
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET
const NETWORK = (process.env.STELLAR_NETWORK ?? "testnet") as 'testnet' | 'mainnet'

// USDC issuer addresses
const USDC_ISSUER = NETWORK === 'testnet'
  ? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
  : "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

/**
 * Create a sponsored Stellar account for a user.
 * The sponsor pays the ~1.5 XLM account reserve.
 * The new account gets a USDC trustline immediately.
 *
 * Ref: https://github.com/oceans404/stellar-sponsored-agent-account
 *
 * IMPORTANT: The new account's private key is NOT stored anywhere.
 * The sponsored account is intended for receiving payments only.
 * Signing is handled via the API key + server-side flow.
 *
 * @param userId - DB user ID (for storing the wallet record)
 * @returns { address: G..., txHash: string }
 */
export async function createSponsoredStellarAccount(
  userId: string
): Promise<{ address: string; txHash: string }> {
  const sponsorSecretKey = process.env.STELLAR_SPONSOR_KEY
  if (!sponsorSecretKey) {
    throw new Error("STELLAR_SPONSOR_KEY not set — cannot create sponsored accounts")
  }

  const sponsorKeypair = Keypair.fromSecret(sponsorSecretKey)
  const newAccountKeypair = Keypair.random()

  const server = new SorobanRpc.Server(RPC_URL)
  const sponsorAccount = await server.getAccount(sponsorKeypair.publicKey())

  // Build the sponsored account creation transaction:
  // 1. Begin sponsoring future reserves (sponsor pays the reserve)
  // 2. Create account (0 XLM start — sponsor covers reserve)
  // 3. Add USDC trustline (new account authorises)
  // 4. End sponsoring future reserves
  const tx = new TransactionBuilder(sponsorAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.beginSponsoringFutureReserves({
      sponsoredId: newAccountKeypair.publicKey(),
    }))
    .addOperation(Operation.createAccount({
      destination: newAccountKeypair.publicKey(),
      startingBalance: "0",
    }))
    .addOperation(Operation.changeTrust({
      asset: new Asset("USDC", USDC_ISSUER),
      source: newAccountKeypair.publicKey(),
    }))
    .addOperation(Operation.endSponsoringFutureReserves({
      source: newAccountKeypair.publicKey(),
    }))
    .setTimeout(30)
    .build()

  // Both sponsor and new account must sign
  tx.sign(sponsorKeypair)
  tx.sign(newAccountKeypair)

  const result = await server.sendTransaction(tx)
  if (result.status === 'ERROR') {
    throw new Error(`Sponsored account creation failed: ${JSON.stringify(result.errorResult)}`)
  }

  // Poll for confirmation (up to 30s)
  const txHash = result.hash
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const txResult = await server.getTransaction(txHash)
    if (txResult.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) break
    if (txResult.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`Sponsored account tx failed: ${txHash}`)
    }
  }

  // Store wallet in DB (private key NOT stored)
  await walletOperations.storeStellarWallet(userId, {
    walletAddress: newAccountKeypair.publicKey(),
    provider: 'stellar-sponsored',
    network: NETWORK,
    isPrimary: true,
    sponsoredAccountTx: txHash,
  })

  console.warn(
    `[sponsored-account] New account created: ${newAccountKeypair.publicKey()}`,
    `Private key NOT stored — agent uses API key for payments`,
    `TX: ${txHash}`
  )

  return { address: newAccountKeypair.publicKey(), txHash }
}
