// Agent 08 adds Stellar-specific hooks (X402ExactHook, MppHook, StellarWalletHook).
// Transport-agnostic proxy infrastructure is here now so the proxy app can import it.
export { withProxy } from "./proxy/index.js"
export { LoggingHook } from "./proxy/hooks/logging-hook.js"
export type { Hook, RequestExtra, CallToolResponseHookResult } from "./proxy/hooks.js"
export type { CallToolRequest, CallToolResult } from "./proxy/hooks.js"
