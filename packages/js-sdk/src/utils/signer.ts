import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { STELLAR_NETWORKS } from '../types.js'
import type { StellarNetwork } from '../types.js'

export type { Keypair }

/**
 * Create a Stellar signer (Keypair) from a secret key.
 * Replaces createSignerFromViemAccount() from MCPay.
 */
export function createStellarSigner(secretKey: string): Keypair {
  return Keypair.fromSecret(secretKey)
}

/**
 * Get the network passphrase for transaction signing.
 * Replaces viem chain objects from MCPay.
 */
export function getNetworkPassphrase(network: StellarNetwork): string {
  return STELLAR_NETWORKS[network].passphrase
}

/**
 * Get the Soroban RPC URL for a network.
 */
export function getRpcUrl(network: StellarNetwork): string {
  return STELLAR_NETWORKS[network].rpcUrl
}

/**
 * Validate a Stellar G... address or C... contract ID.
 * Replaces getAddress() from viem.
 */
export function validateStellarAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address)
  } catch {
    return false
  }
}
