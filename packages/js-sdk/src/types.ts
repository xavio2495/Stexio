// Stexio types — Stellar-only, replaces x402/types EVM/SVM types

export type StellarNetwork = 'testnet' | 'mainnet'

export type PaymentMode = 'x402-exact' | 'x402-session' | 'mpp-charge' | 'mpp-session'

export interface StellarRecipient {
  address: string        // G... Stellar address
  isTestnet: boolean
}

export interface StexioConfig {
  recipient: {
    stellar: StellarRecipient
  }
  paymentModes: PaymentMode[]
  sessionContractId?: string      // required if 'x402-session' in modes
  facilitator?: {
    url: string
  }
  version?: number
}

export const STELLAR_NETWORKS = {
  testnet: {
    identifier: 'stellar:testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    usdc: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  },
  mainnet: {
    identifier: 'stellar:pubnet',
    rpcUrl: 'https://horizon.stellar.org',
    passphrase: 'Public Global Stellar Network ; September 2015',
    usdc: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  },
} as const

export const SUPPORTED_PAYMENT_MODES: PaymentMode[] = [
  'x402-exact',
  'x402-session',
  'mpp-charge',
  'mpp-session',
]

export const DEFAULT_FACILITATOR_URL = 'https://www.x402.org/facilitator'

export const USDC_DECIMALS = 7  // 1 USDC = 10_000_000 stroops on Stellar
