import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { bearer, mcp } from "better-auth/plugins"
import { drizzle } from "drizzle-orm/neon-http"
import { neon, neonConfig } from "@neondatabase/serverless"
import * as schema from "../../auth-schema.js"
import { config } from "dotenv"

config()

// Enable fetch connection cache to support transactional flows over Neon HTTP
neonConfig.fetchConnectionCache = true
const sql = neon(process.env.DATABASE_URL!)
export const db = drizzle(sql, { schema })

function crossDomainConfig() {
  const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
  return {
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: isDev ? ".localhost" : ".stexio.xyz",
      },
      useSecureCookies: !isDev,
    },
  }
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL!,
  database: drizzleAdapter(db, { provider: "pg" }),
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "http://localhost:3000").split(","),
  emailAndPassword: { enabled: true },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
  plugins: [
    // bearer: converts Authorization: Bearer <token> to session cookie — enables CLI/agent API key auth
    // NOTE: better-auth v1.6.2 removed the apiKey plugin; bearer() is the equivalent for token auth
    bearer(),
    mcp({ loginPage: "/connect" }),
  ],
  ...crossDomainConfig(),
})

export type Session = typeof auth.$Infer.Session
export type User = typeof auth.$Infer.Session.user
