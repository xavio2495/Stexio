import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Allow importing ESM packages used in API routes
  serverExternalPackages: ['@stellar/stellar-sdk', 'x402-turbo-stellar', 'x402-stellar'],
  outputFileTracingRoot: __dirname,
}

export default nextConfig
