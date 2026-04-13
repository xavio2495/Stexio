// Client-safe config (NEXT_PUBLIC_ prefix)
export const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'

// Test definitions — ordered for display and run-all sequencing
export const FEATURE_TESTS = [
  { id: 'health',                title: 'Proxy Health',                  description: 'GET /health — verifies the proxy is up and returns ok:true', group: 'infrastructure' },
  { id: 'benchmark',             title: 'Benchmark',                     description: 'Run all tests sequentially and report timing per route', group: 'infrastructure' },
  { id: 'auth-signup',           title: 'Auth — Sign Up',                description: 'POST /api/auth/sign-up/email — create test account', group: 'auth' },
  { id: 'auth-signin',           title: 'Auth — Sign In',                description: 'POST /api/auth/sign-in/email — get session token', group: 'auth' },
  { id: 'auth-session',          title: 'Auth — Session',                description: 'GET /api/auth/get-session with Bearer token — verify session', group: 'auth' },
  { id: 'server-register',       title: 'Server Register',               description: 'POST /register — register echo MCP server with proxy', group: 'registry' },
  { id: 'server-list',           title: 'Server List',                   description: 'GET /servers — list all registered servers', group: 'registry' },
  { id: 'mcp-unauth',            title: 'MCP — 402 Detection',           description: 'Tool call without payment — verify proxy returns payment error', group: 'payment' },
  { id: 'payment-x402-coinbase', title: 'x402 — Coinbase facilitator',   description: 'x402 exact scheme via Coinbase facilitator — Soroban tx signing + proxy round-trip', group: 'payment' },
  { id: 'payment-x402-stellar',  title: 'x402 — Stellar facilitator',    description: 'x402-stellar: call useFacilitator verify+settle directly without proxy', group: 'payment' },
  { id: 'payment-turbo',         title: 'x402-turbo-stellar',            description: 'x402 session channel — sign payment nonce locally, proxy verifies Ed25519 signature', group: 'payment' },
  { id: 'payment-mpp',           title: 'MPP Charge',                    description: 'MPP charge credential — proxy validates struct, marks mpp/paid', group: 'payment' },
  { id: 'payment-mpp-session',   title: 'MPP Session',                   description: 'MPP session voucher credential — proxy validates cumulative amount, marks mpp/paid', group: 'payment' },
  { id: 'apikey-mode',           title: 'API Key Mode',                  description: 'Bearer token auth — sign in, call proxy /mcp with Authorization header', group: 'auth' },
] as const

export type TestId = typeof FEATURE_TESTS[number]['id']
