import { and, desc, eq, inArray } from "drizzle-orm"
import * as schema from "../../../auth-schema.js"
import { db } from "../auth.js"
import { randomUUID } from "node:crypto"

export type StellarWallet = {
  id: string
  userId: string
  provider: string | null
  walletAddress: string | null
  blockchain: string | null
  walletType: string | null
  isPrimary: boolean
  isActive: boolean
  walletMetadata: {
    network: 'testnet' | 'mainnet'
    usdcBalance?: string
    xlmBalance?: string
    sponsoredAccountTx?: string
  } | null
  createdAt: Date
  updatedAt: Date
  lastUsedAt: Date | null
}

export const walletOperations = {

  // Get all active Stellar wallets for a user
  getStellarWalletsByUser: async (userId: string): Promise<StellarWallet[]> => {
    return db
      .select()
      .from(schema.userWallets)
      .where(
        and(
          eq(schema.userWallets.userId, userId),
          inArray(schema.userWallets.provider, ["stellar", "stellar-sponsored"]),
          eq(schema.userWallets.isActive, true),
        )
      )
      .orderBy(
        desc(schema.userWallets.isPrimary),
        desc(schema.userWallets.createdAt)
      ) as unknown as StellarWallet[]
  },

  // Check if user has any active Stellar wallet
  userHasStellarWallet: async (userId: string): Promise<boolean> => {
    const rows = await db
      .select({ id: schema.userWallets.id })
      .from(schema.userWallets)
      .where(
        and(
          eq(schema.userWallets.userId, userId),
          inArray(schema.userWallets.provider, ["stellar", "stellar-sponsored"]),
          eq(schema.userWallets.isActive, true),
        )
      )
      .limit(1)
    return rows.length > 0
  },

  // Get primary Stellar wallet for a user
  getPrimaryStellarWallet: async (userId: string): Promise<StellarWallet | null> => {
    const wallets = await walletOperations.getStellarWalletsByUser(userId)
    return wallets.find(w => w.isPrimary) ?? wallets[0] ?? null
  },

  // Store a new Stellar wallet (Freighter connect or sponsored creation)
  storeStellarWallet: async (
    userId: string,
    data: {
      walletAddress: string             // G... Stellar address
      provider: 'stellar' | 'stellar-sponsored'
      network: 'testnet' | 'mainnet'
      isPrimary?: boolean
      sponsoredAccountTx?: string
      xlmBalance?: string
      usdcBalance?: string
    }
  ): Promise<StellarWallet> => {
    const id = randomUUID()
    await db.insert(schema.userWallets).values({
      id,
      userId,
      provider: data.provider,
      walletAddress: data.walletAddress,
      blockchain: "stellar",
      architecture: "ed25519",
      walletType: data.provider === 'stellar' ? 'external' : 'managed',
      isPrimary: data.isPrimary ?? true,
      isActive: true,
      walletMetadata: {
        network: data.network,
        sponsoredAccountTx: data.sponsoredAccountTx,
        xlmBalance: data.xlmBalance,
        usdcBalance: data.usdcBalance,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    return (await walletOperations.getPrimaryStellarWallet(userId))!
  },

  // Deactivate all wallets for a user (on account disconnect)
  deactivateUserWallets: async (userId: string): Promise<void> => {
    await db
      .update(schema.userWallets)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(schema.userWallets.userId, userId))
  },
}
