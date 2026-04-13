import { Redis } from '@upstash/redis'
import { z } from 'zod'
import { config } from 'dotenv'

config()

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'Missing required Upstash Redis env vars: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN'
  )
}

export const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
})

// Key prefixes — stexio: namespace (migrated from mcp: in MCPay)
const KEYS = {
  SERVER: 'stexio:server:',
  SERVER_BY_ORIGIN: 'stexio:origin:',
  TOOLS: 'stexio:tools:',
  AUDIT: 'stexio:audit:',
  SERVER_IDS_SET: 'stexio:server_ids',
} as const

// Validation schemas

const StoredToolSchema = z.object({
  name: z.string(),
  pricing: z.string(), // "$0.001" format
})

// STEXIO: Stellar-only recipient schema (replaces evm/svm for new records)
const StellarRecipientSchema = z.object({
  address: z.string().min(56).max(56), // G... Stellar address, 56 chars
  isTestnet: z.boolean().default(true),
})

const RecipientSchema = z.object({
  stellar: StellarRecipientSchema.optional(),
  // Legacy EVM/SVM fields — kept for backward-compat reads only, never write these
  evm: z
    .object({
      address: z.string(),
      isTestnet: z.boolean().optional(),
    })
    .optional(),
  svm: z
    .object({
      address: z.string(),
      isTestnet: z.boolean().optional(),
    })
    .optional(),
})

// STEXIO: Payment modes supported by a registered server
const PaymentModeSchema = z.enum([
  'x402-exact',
  'x402-session',
  'mpp-charge',
  'mpp-session',
])

const StoredServerConfigSchema = z.object({
  id: z.string(),
  mcpOrigin: z.string(),
  requireAuth: z.boolean().optional().default(false),
  authHeaders: z.record(z.string(), z.string()).optional().default({}),

  // Recipient wallet — Stellar only for new records
  recipient: RecipientSchema.optional(),

  // Legacy field — keep for backward-compat reads, never write new records with it
  receiverAddressByNetwork: z.record(z.string(), z.string()).optional(),

  // STEXIO NEW: payment modes this server accepts
  paymentModes: z.array(PaymentModeSchema).default(['x402-exact']),

  // STEXIO NEW: deployed SessionChannel contract for x402-turbo session mode
  sessionContractId: z.string().optional(),

  tools: z.array(StoredToolSchema).optional().default([]),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
})

const StoreShapeSchema = z.object({
  serversById: z.record(z.string(), StoredServerConfigSchema),
  serverIdByOrigin: z.record(z.string(), z.string()),
})

// Exported types
export type StoredTool = z.infer<typeof StoredToolSchema>
export type StoredServerConfig = z.infer<typeof StoredServerConfigSchema>
export type PaymentMode = z.infer<typeof PaymentModeSchema>
export type StoreShape = z.infer<typeof StoreShapeSchema>

// Redis store class
export class RedisMcpStore {
  private redis: Redis

  constructor(redisInstance?: Redis) {
    this.redis = redisInstance || redis
  }

  // Initialize Redis connection and run namespace migration if needed
  async connect(): Promise<void> {
    try {
      await this.redis.ping()
      console.log(`[${new Date().toISOString()}] Upstash Redis connected successfully`)

      // Migrate from old mcp: namespace if stexio: set is empty
      const stexioServerCount = await this.redis.scard(KEYS.SERVER_IDS_SET)
      if (stexioServerCount === 0) {
        await this.migrateFromMcpKeys()
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Upstash Redis connection failed — store will retry on first request:`, error)
      // Don't re-throw: let the proxy stay up; per-request errors are caught individually
    }
  }

  // Load all data from Redis
  async loadStore(): Promise<StoreShape> {
    try {
      let serverIds = await this.redis.smembers(KEYS.SERVER_IDS_SET)

      // If the set is empty, scan existing stexio: keys and rebuild the set
      if (serverIds.length === 0) {
        console.log(
          `[${new Date().toISOString()}] SERVER_IDS_SET is empty, rebuilding from existing keys...`
        )
        await this.migrateExistingServersToSet()
        serverIds = await this.redis.smembers(KEYS.SERVER_IDS_SET)
      }

      const serversById: Record<string, StoredServerConfig> = {}
      const serverIdByOrigin: Record<string, string> = {}

      for (const serverId of serverIds) {
        const serverData = await this.redis.get(`${KEYS.SERVER}${serverId}`)
        if (serverData) {
          try {
            const parsed =
              typeof serverData === 'string' ? JSON.parse(serverData) : serverData
            const validated = StoredServerConfigSchema.parse(parsed)
            serversById[serverId] = validated
            serverIdByOrigin[validated.mcpOrigin] = serverId
          } catch (error) {
            console.warn(
              `[${new Date().toISOString()}] Invalid server data for ${serverId}:`,
              error
            )
          }
        }
      }

      console.log(
        `[${new Date().toISOString()}] Loaded ${Object.keys(serversById).length} servers from Redis`
      )
      return { serversById, serverIdByOrigin }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error loading store from Redis:`, error)
      return { serversById: {}, serverIdByOrigin: {} }
    }
  }

  // Save (upsert) server configuration — merges with existing record
  async upsertServerConfig(
    input: Partial<StoredServerConfig> & { id: string; mcpOrigin: string }
  ): Promise<StoredServerConfig> {
    try {
      const existingData = await this.redis.get(`${KEYS.SERVER}${input.id}`)
      const current = existingData
        ? typeof existingData === 'string'
          ? JSON.parse(existingData)
          : existingData
        : { id: input.id, mcpOrigin: input.mcpOrigin }

      // STEXIO: merge logic includes new fields
      const merged: StoredServerConfig = {
        ...current,
        ...input,
        authHeaders: { ...(current.authHeaders ?? {}), ...(input.authHeaders ?? {}) },
        recipient: input.recipient ?? current.recipient,
        paymentModes: input.paymentModes ?? current.paymentModes ?? ['x402-exact'],
        sessionContractId: input.sessionContractId ?? current.sessionContractId,
        tools: input.tools ?? current.tools ?? [],
        metadata: { ...(current.metadata ?? {}), ...(input.metadata ?? {}) },
      }

      const validated = StoredServerConfigSchema.parse(merged)

      const expirationSeconds = 30 * 24 * 60 * 60 // 30 days

      const pipeline = this.redis.pipeline()
      pipeline.setex(
        `${KEYS.SERVER}${merged.id}`,
        expirationSeconds,
        JSON.stringify(validated)
      )
      pipeline.setex(
        `${KEYS.SERVER_BY_ORIGIN}${merged.mcpOrigin}`,
        expirationSeconds,
        merged.id
      )
      pipeline.sadd(KEYS.SERVER_IDS_SET, merged.id)

      if (merged.tools && merged.tools.length > 0) {
        pipeline.setex(
          `${KEYS.TOOLS}${merged.id}`,
          expirationSeconds,
          JSON.stringify(merged.tools)
        )
      }

      await pipeline.exec()

      await this.logAudit('upsert', 'server', merged.id, {
        action: 'upsert_server',
        serverId: merged.id,
      })

      return validated
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error upserting server config:`, error)
      throw error
    }
  }

  // Get server by ID
  async getServerById(id: string): Promise<StoredServerConfig | null> {
    try {
      const data = await this.redis.get(`${KEYS.SERVER}${id}`)
      if (!data) return null
      const parsed = typeof data === 'string' ? JSON.parse(data) : data
      return StoredServerConfigSchema.parse(parsed)
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error getting server by ID:`, error)
      return null
    }
  }

  // Get server by origin URL
  async getServerByOrigin(origin: string): Promise<StoredServerConfig | null> {
    try {
      const serverId = await this.redis.get(`${KEYS.SERVER_BY_ORIGIN}${origin}`)
      if (!serverId) return null
      return await this.getServerById(serverId as string)
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error getting server by origin:`, error)
      return null
    }
  }

  // Get all servers for listing
  async getAllServers(): Promise<Array<{ id: string; url: string }>> {
    try {
      let serverIds = await this.redis.smembers(KEYS.SERVER_IDS_SET)

      if (serverIds.length === 0) {
        console.log(
          `[${new Date().toISOString()}] SERVER_IDS_SET is empty, rebuilding from existing keys...`
        )
        await this.migrateExistingServersToSet()
        serverIds = await this.redis.smembers(KEYS.SERVER_IDS_SET)
      }

      const servers = []
      for (const serverId of serverIds) {
        const server = await this.getServerById(serverId)
        if (server) {
          servers.push({
            id: serverId,
            url: `${process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:3006'}/mcp?id=${serverId}`,
          })
        }
      }

      return servers
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error getting all servers:`, error)
      return []
    }
  }

  // Delete server by ID
  async deleteServer(id: string): Promise<boolean> {
    try {
      const server = await this.getServerById(id)
      if (!server) return false

      const pipeline = this.redis.pipeline()
      pipeline.del(`${KEYS.SERVER}${id}`)
      pipeline.del(`${KEYS.SERVER_BY_ORIGIN}${server.mcpOrigin}`)
      pipeline.del(`${KEYS.TOOLS}${id}`)
      pipeline.srem(KEYS.SERVER_IDS_SET, id)

      await pipeline.exec()

      await this.logAudit('delete', 'server', id, { action: 'delete_server', serverId: id })
      return true
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error deleting server:`, error)
      return false
    }
  }

  // Rebuild stexio:server_ids SET from existing stexio:server:* keys
  // (handles the case where stexio: keys exist but the SET was lost)
  private async migrateExistingServersToSet(): Promise<void> {
    try {
      console.log(
        `[${new Date().toISOString()}] Rebuilding SERVER_IDS_SET from existing stexio:server:* keys...`
      )
      const serverKeys = await this.redis.keys(`${KEYS.SERVER}*`)

      if (serverKeys.length === 0) {
        console.log(`[${new Date().toISOString()}] No existing stexio: servers found`)
        return
      }

      const serverIds = serverKeys.map((key) => key.replace(KEYS.SERVER, ''))
      const pipeline = this.redis.pipeline()
      for (const serverId of serverIds) {
        pipeline.sadd(KEYS.SERVER_IDS_SET, serverId)
      }
      await pipeline.exec()
      console.log(
        `[${new Date().toISOString()}] Rebuilt SERVER_IDS_SET with ${serverIds.length} servers`
      )
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Error rebuilding SERVER_IDS_SET:`,
        error
      )
    }
  }

  // Cross-namespace migration: read old mcp: keys, re-save under stexio: namespace
  // Runs once on connect() when stexio:server_ids is empty
  private async migrateFromMcpKeys(): Promise<void> {
    const oldServerIds = await this.redis.smembers('mcp:server_ids')
    if (oldServerIds.length === 0) return

    console.log(
      `[${new Date().toISOString()}] Migrating ${oldServerIds.length} servers from mcp: to stexio: namespace`
    )

    for (const serverId of oldServerIds) {
      const oldData = await this.redis.get(`mcp:server:${serverId}`)
      if (!oldData) continue
      try {
        const parsed = typeof oldData === 'string' ? JSON.parse(oldData) : oldData
        await this.upsertServerConfig({
          ...parsed,
          paymentModes: parsed.paymentModes ?? ['x402-exact'],
        })
      } catch (err) {
        console.warn(`[migration] Failed to migrate server ${serverId}:`, err)
      }
    }

    console.log('[migration] Complete')
  }

  // Audit logging — keeps last 1000 entries
  async logAudit(
    action: string,
    tableName: string,
    recordId: string,
    details?: unknown
  ): Promise<void> {
    try {
      const auditEntry = {
        action,
        tableName,
        recordId,
        timestamp: new Date().toISOString(),
        details: details ? JSON.stringify(details) : null,
      }

      await this.redis.lpush(`${KEYS.AUDIT}${Date.now()}`, JSON.stringify(auditEntry))
      await this.redis.ltrim(`${KEYS.AUDIT}`, 0, 999)
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error logging audit:`, error)
    }
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.redis.ping()
      return result === 'PONG'
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Redis health check failed:`, error)
      return false
    }
  }

  // Upstash Redis is stateless — no real disconnection needed
  async disconnect(): Promise<void> {
    console.log(`[${new Date().toISOString()}] Upstash Redis disconnected (stateless)`)
  }
}

/**
 * Build a recipient map for x402 payment requirements from a server config.
 * Returns { 'stellar:testnet': 'G...address' } or { 'stellar:pubnet': 'G...address' }
 * Returns empty object if no stellar recipient configured.
 */
export function buildStellarRecipientMap(
  server: StoredServerConfig
): Record<string, string> {
  if (!server.recipient?.stellar?.address) return {}
  const networkId = server.recipient.stellar.isTestnet
    ? 'stellar:testnet'
    : 'stellar:pubnet'
  return { [networkId]: server.recipient.stellar.address }
}

export const redisStore = new RedisMcpStore()
export default redisStore
