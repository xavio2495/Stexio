import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import getPort from "get-port"
import { config } from "dotenv"
import { redisStore, buildStellarRecipientMap, type StoredServerConfig } from "./db/redis.js"
import { auth } from "./lib/auth.js"
import { LoggingHook, withProxy, type Hook } from "@stexio/js-sdk/handler"
import { X402ExactHook, X402SessionHook } from "./lib/hooks/x402-hook.js"
import { Keypair } from "@stellar/stellar-sdk"
// Agent 06 imports: MppChargeHook, MppSessionHook from "./lib/hooks/mpp-hook.js"
// Agent 07 imports: StellarWalletHook from "./lib/hooks/stellar-wallet-hook.js"

config()

export const runtime = "nodejs"

// Price type: numeric USDC value (e.g. 0.001 = $0.001)
type Price = number | string

// ─── Store initialization ─────────────────────────────────────────────────────

async function initializeStore(): Promise<void> {
  await redisStore.connect()
}

void initializeStore()

// ─── URL resolution (ported from mcp2 — unchanged) ───────────────────────────

async function resolveTargetUrl(req: Request, absoluteUrl?: string): Promise<string | null> {
  let url: URL
  try {
    if (absoluteUrl) {
      url = new URL(absoluteUrl)
    } else {
      try {
        url = new URL(req.url)
      } catch {
        const host = req.headers.get("host") || req.headers.get("x-forwarded-host")
        const protocol = req.headers.get("x-forwarded-proto") || "https"
        if (host) {
          url = new URL(req.url, `${protocol}://${host}`)
        } else {
          url = new URL(req.url, "http://localhost")
        }
      }
    }
  } catch {
    return null
  }

  const id = url.searchParams.get("id")
  if (id) {
    const server = await redisStore.getServerById(id)
    if (server?.mcpOrigin) return server.mcpOrigin
  }

  const directEncoded = req.headers.get("x-stexio-target-url") ?? url.searchParams.get("target-url")
  if (directEncoded) {
    try {
      return atob(decodeURIComponent(directEncoded))
    } catch {
      return directEncoded
    }
  }
  return null
}

// ─── Monetization builder (STEXIO: Stellar-only) ─────────────────────────────

async function buildMonetizationForTarget(targetUrl: string): Promise<{
  prices: Record<string, Price>
  recipient: Record<string, string>
  paymentModes: StoredServerConfig["paymentModes"]
  sessionContractId?: string
} | null> {
  try {
    const server = await redisStore.getServerByOrigin(targetUrl)
    if (!server) return null

    // Build Stellar recipient map
    const recipient = buildStellarRecipientMap(server)
    if (Object.keys(recipient).length === 0) return null

    // Build prices per tool
    const prices: Record<string, Price> = {}
    for (const tool of (server.tools ?? [])) {
      if (typeof tool.pricing === "string" && tool.pricing.startsWith("$")) {
        const numericValue = parseFloat(tool.pricing.substring(1))
        if (!isNaN(numericValue) && numericValue > 0) {
          prices[tool.name] = numericValue
        }
      }
    }

    return {
      prices,
      recipient,
      paymentModes: server.paymentModes ?? ["x402-exact"],
      sessionContractId: server.sessionContractId,
    }
  } catch {
    return null
  }
}

// ─── Auth middleware (bearer() compatible) ────────────────────────────────────

async function getSessionFromRequest(req: Request): Promise<string | null> {
  // bearer() plugin converts Authorization: Bearer <token> to a session automatically
  // getSession() handles both cookie sessions and Bearer token sessions
  try {
    const session = await auth.api.getSession({ headers: req.headers })
    if (session?.user?.id) return session.user.id
  } catch { /* fall through */ }
  return null
}

// ─── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono()
app.use("*", cors())

// ─── Auth endpoints (proxied from better-auth) ────────────────────────────────

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw)
})

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({
  ok: true,
  service: "stexio-proxy",
  network: process.env.STELLAR_NETWORK ?? "testnet",
}))

// ─── Register MCP server ──────────────────────────────────────────────────────

app.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null) as {
    id?: string
    mcpOrigin?: string
    requireAuth?: boolean
    authHeaders?: Record<string, string>
    recipient?: {
      stellar?: { address: string; isTestnet?: boolean }
    }
    paymentModes?: Array<"x402-exact" | "x402-session" | "mpp-charge" | "mpp-session">
    sessionContractId?: string
    tools?: Array<{ name: string; pricing: string }>
    metadata?: Record<string, unknown>
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_json" }, 400)
  }

  const { id, mcpOrigin } = body
  if (!id || !mcpOrigin) {
    return c.json({ error: "missing_id_or_origin" }, 400)
  }

  // Validate Stellar address if provided
  if (body.recipient?.stellar?.address) {
    const addr = body.recipient.stellar.address
    if (!addr.startsWith("G") || addr.length !== 56) {
      return c.json({ error: "invalid_stellar_address" }, 400)
    }
  }

  try {
    const saved = await redisStore.upsertServerConfig({
      id,
      mcpOrigin,
      requireAuth: body.requireAuth === true,
      authHeaders: body.authHeaders ?? {},
      recipient: body.recipient
        ? {
            ...body.recipient,
            stellar: body.recipient.stellar
              ? { address: body.recipient.stellar.address, isTestnet: body.recipient.stellar.isTestnet ?? true }
              : undefined,
          }
        : undefined,
      paymentModes: body.paymentModes ?? ["x402-exact"],
      sessionContractId: body.sessionContractId,
      tools: Array.isArray(body.tools) ? body.tools : [],
      metadata: body.metadata ?? {},
    })
    return c.json({ ok: true, id: saved.id })
  } catch {
    return c.json({ error: "failed_to_save" }, 500)
  }
})

// ─── List servers ─────────────────────────────────────────────────────────────

app.get("/servers", async (c) => {
  try {
    const list = await redisStore.getAllServers()
    return c.json({ servers: list })
  } catch {
    return c.json({ error: "failed_to_list" }, 500)
  }
})

// ─── MCP proxy endpoint ───────────────────────────────────────────────────────

app.all("/mcp", async (c) => {
  const original = c.req.raw
  const targetUrl = await resolveTargetUrl(original, c.req.url)

  const currentUrl = new URL(c.req.url)
  const serverId = currentUrl.searchParams.get("id")
  if (!serverId) return new Response("server-id missing", { status: 400 })
  if (!targetUrl) return new Response("target-url missing", { status: 400 })

  // Get monetization config for this server
  const monetization = await buildMonetizationForTarget(targetUrl)

  // Get session user for auto-payment hook (Agent 07 uses this for StellarWalletHook)
  const _userId = await getSessionFromRequest(original)

  // Build headers
  const headers = new Headers(original.headers)
  if (!headers.get("x-stexio-target-url")) {
    headers.set("x-stexio-target-url", btoa(targetUrl))
  }

  const mcpConfig = await redisStore.getServerById(serverId)

  // Inject auth headers if required
  if (mcpConfig?.authHeaders && mcpConfig.requireAuth === true) {
    for (const [key, value] of Object.entries(mcpConfig.authHeaders)) {
      if (typeof value === "string" && value.length > 0) {
        headers.set(key, value)
      }
    }
  }

  // Build hook pipeline
  const hooks: Hook[] = [new LoggingHook()]

  if (monetization && Object.keys(monetization.prices).length > 0) {
    const samplePrice = (Object.values(monetization.prices)[0] as number) ?? 0.001
    const recipientAddress = Object.values(monetization.recipient)[0] ?? ""
    const network = (process.env.STELLAR_NETWORK ?? "testnet") as "testnet" | "mainnet"

    if (monetization.paymentModes.includes("x402-exact") && recipientAddress) {
      hooks.push(new X402ExactHook({
        recipientAddress,
        facilitatorUrl: process.env.FACILITATOR_URL ?? "https://www.x402.org/facilitator",
        network,
        pricePerCall: samplePrice,
      }))
    }

    if (
      monetization.paymentModes.includes("x402-session") &&
      monetization.sessionContractId &&
      process.env.STELLAR_SERVER_SECRET_KEY
    ) {
      hooks.push(new X402SessionHook({
        contractId: monetization.sessionContractId,
        serverKeypair: Keypair.fromSecret(process.env.STELLAR_SERVER_SECRET_KEY),
        network,
        pricePerCall: BigInt(Math.round(samplePrice * 10_000_000)),
        batchSize: 10,
        batchIntervalMs: 30_000,
      }))
    }
    // Agent 06: push MppChargeHook + MppSessionHook
    // Agent 07: push StellarWalletHook
  }

  const reqForProxy = new Request(c.req.url, {
    method: original.method,
    headers,
    body: original.body,
    duplex: "half",
  } as RequestInit)

  const proxy = withProxy(targetUrl, hooks)
  return proxy(reqForProxy)
})

// ─── Server startup ───────────────────────────────────────────────────────────

const portPromise = getPort({ port: process.env.PORT ? Number(process.env.PORT) : 3006 })
const port = await portPromise

const isVercel = !!process.env.VERCEL

if (!isVercel) {
  serve({
    fetch: app.fetch,
    port,
    hostname: "0.0.0.0",
  }, () => {
    console.log(`[stexio-proxy] listening on port ${port}`)
    console.log(`[stexio-proxy] network: ${process.env.STELLAR_NETWORK ?? "testnet"}`)
  })
}

export default isVercel ? app : { app, port }
