import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  CompleteRequestSchema,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { withStellarClient } from '../../client/with-stellar-client.js'
import type { StellarClientConfig } from '../../client/with-stellar-client.js'

export enum ServerType {
  HTTPStream = 'HTTPStream',
}

export interface ServerConnection {
  url: string
  serverType: ServerType
}

export interface StartStdioServerConfig {
  serverConnections: ServerConnection[]
  stellarClientConfig?: StellarClientConfig
  apiKey?: string
  clientName?: string
  clientVersion?: string
}

/**
 * Starts an MCP stdio server that proxies requests to remote paid MCP servers.
 * Replaces startStdioServer from MCPay — uses withStellarClient instead of withX402Client.
 */
export async function startStdioServer(config: StartStdioServerConfig): Promise<Server[]> {
  if (config.serverConnections.length === 0) {
    throw new Error('No server connections provided')
  }

  const servers: Server[] = []

  for (const connection of config.serverConnections) {
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.url),
      config.apiKey
        ? { requestInit: { headers: { Authorization: `Bearer ${config.apiKey}` } } }
        : undefined
    )

    const upstreamClient = new Client(
      {
        name: config.clientName ?? 'stexio-cli',
        version: config.clientVersion ?? '0.1.0',
      },
      { capabilities: {} }
    )

    await upstreamClient.connect(transport)

    // Wrap with payment capabilities if configured
    const payingClient = config.stellarClientConfig
      ? withStellarClient(upstreamClient, config.stellarClientConfig)
      : upstreamClient

    const serverVersion = upstreamClient.getServerVersion() as { name: string; version: string }
    const serverCapabilities = upstreamClient.getServerCapabilities() as ServerCapabilities

    // Create local stdio-facing server
    const stdioServer = new Server(serverVersion, { capabilities: serverCapabilities })

    // Wire request handlers — forward all MCP requests to upstream
    if (serverCapabilities?.tools) {
      stdioServer.setRequestHandler(ListToolsRequestSchema, async (args) => {
        return upstreamClient.listTools(args.params)
      })
      stdioServer.setRequestHandler(CallToolRequestSchema, async (args) => {
        return payingClient.callTool(args.params)
      })
    }

    if (serverCapabilities?.prompts) {
      stdioServer.setRequestHandler(ListPromptsRequestSchema, async (args) => {
        return upstreamClient.listPrompts(args.params)
      })
      stdioServer.setRequestHandler(GetPromptRequestSchema, async (args) => {
        return upstreamClient.getPrompt(args.params)
      })
    }

    if (serverCapabilities?.resources) {
      stdioServer.setRequestHandler(ListResourcesRequestSchema, async (args) => {
        return upstreamClient.listResources(args.params)
      })
      stdioServer.setRequestHandler(ListResourceTemplatesRequestSchema, async (args) => {
        return upstreamClient.listResourceTemplates(args.params)
      })
      stdioServer.setRequestHandler(ReadResourceRequestSchema, async (args) => {
        return upstreamClient.readResource(args.params)
      })
    }

    stdioServer.setRequestHandler(CompleteRequestSchema, async (args) => {
      return upstreamClient.complete(args.params)
    })

    const stdioTransport = new StdioServerTransport()
    await stdioServer.connect(stdioTransport)

    servers.push(stdioServer)
  }

  return servers
}

/**
 * Creates server connection configurations from a list of URLs.
 */
export function createServerConnections(
  urls: string[],
  serverType: ServerType = ServerType.HTTPStream
): ServerConnection[] {
  return urls.map(url => ({ url, serverType }))
}
