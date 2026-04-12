// @stexio/js-sdk — public exports

// Types & constants
export type { StellarNetwork, PaymentMode, StellarRecipient, StexioConfig } from './types.js'
export {
  STELLAR_NETWORKS,
  SUPPORTED_PAYMENT_MODES,
  DEFAULT_FACILITATOR_URL,
  USDC_DECIMALS,
} from './types.js'

// Utilities
export { createStellarSigner, getNetworkPassphrase, getRpcUrl, validateStellarAddress } from './utils/signer.js'
export type { Keypair } from './utils/signer.js'

// Client-side (connect to a paid MCP server)
export { withStellarClient } from './client/with-stellar-client.js'
export type { StellarClientConfig, StellarAugmentedClient } from './client/with-stellar-client.js'

// Server plugin (monetize your MCP server with paidTool)
export { withX402 } from './handler/server/plugins/with-x402.js'
export type { StexioAugmentedServer } from './handler/server/plugins/with-x402.js'

// Proxy utilities (chain-agnostic MCP proxy pipeline)
export { withProxy } from './handler/proxy/index.js'
export { LoggingHook } from './handler/proxy/hooks/logging-hook.js'
export type {
  Hook,
  RequestExtra,
  CallToolResponseHookResult,
  CallToolRequest,
  CallToolResult,
} from './handler/proxy/hooks.js'

// Server / stdio bridge
export { startStdioServer, createServerConnections, ServerType } from './server/stdio/start-stdio-server.js'
export type { StartStdioServerConfig, ServerConnection } from './server/stdio/start-stdio-server.js'
