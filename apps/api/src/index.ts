import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMcpHandler } from "mcp-handler";
import type { McpToolDefinition } from "openapi-mcp-generator";
import { getToolsFromOpenApi } from "openapi-mcp-generator";
import type { OpenAPIV3 } from "openapi-types";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import getPort from "get-port";

const app = new Hono();

type PrimitiveParam = string | number | boolean | null | undefined;
type ParamsMap = Record<string, PrimitiveParam>;

type ExecutionParameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie" | string;
};

type ToolWithBaseUrl = McpToolDefinition & { baseUrl?: string };

const normalizeHeaders = (headersInput: unknown): Record<string, string> => {
  if (!headersInput) return {};
  if (typeof headersInput === "object" && !Array.isArray(headersInput)) {
    const record: Record<string, string> = {};
    Object.entries(headersInput as Record<string, unknown>).forEach(
      ([k, v]) => {
        if (typeof v === "string") record[k] = v;
      },
    );
    return record;
  }
  if (Array.isArray(headersInput)) {
    const record: Record<string, string> = {};
    for (const entry of headersInput as Array<[string, string]>) {
      const [k, v] = entry;
      if (typeof k === "string" && typeof v === "string") record[k] = v;
    }
    return record;
  }
  return {};
};

const buildExecutionParams = (
  tool: ToolWithBaseUrl,
): ReadonlyArray<ExecutionParameter> => {
  if (
    Array.isArray(tool.executionParameters) &&
    tool.executionParameters.length > 0
  ) {
    return tool.executionParameters as ReadonlyArray<ExecutionParameter>;
  }
  if (Array.isArray(tool.parameters) && tool.parameters.length > 0) {
    return (tool.parameters as ReadonlyArray<OpenAPIV3.ParameterObject>).map(
      (p) => ({
        name: p.name,
        in: p.in,
      }),
    );
  }
  return [];
};

const executeDynamicTool = async (opts: {
  name: string;
  method: string;
  baseUrl: string;
  pathTemplate: string;
  parameters: ReadonlyArray<ExecutionParameter>;
  requestBodyContentType?: string;
  params: ParamsMap;
  originalHeaders: Record<string, string>;
}): Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> => {
  const {
    name,
    method,
    baseUrl,
    pathTemplate,
    parameters,
    requestBodyContentType,
    params,
    originalHeaders,
  } = opts;
  try {
    let url = pathTemplate;
    const queryParams = new URLSearchParams();
    let requestBody: string | undefined;
    const headers: Record<string, string> = {};

    const headersToSkip = new Set([
      "host",
      "content-length",
      "connection",
      "upgrade",
      "expect",
    ]);
    Object.entries(originalHeaders).forEach(([key, value]) => {
      if (!headersToSkip.has(key.toLowerCase()) && typeof value === "string") {
        headers[key] = value;
      }
    });

    if (requestBodyContentType) {
      headers["Content-Type"] = requestBodyContentType;
    }

    if (parameters && Array.isArray(parameters)) {
      parameters.forEach((param) => {
        const value = params[param.name];
        if (value !== undefined && value !== null) {
          switch (param.in) {
            case "path":
              url = url.includes(`{${param.name}}`)
                ? url.replace(
                    `{${param.name}}`,
                    encodeURIComponent(String(value)),
                  )
                : (queryParams.append(param.name, String(value)), url);
              break;
            case "query":
              queryParams.append(param.name, String(value));
              break;
            case "header":
              headers[param.name] = String(value);
              break;
          }
        }
      });
    }

    const upperMethod = method.toUpperCase();
    if (["POST", "PUT", "PATCH"].includes(upperMethod)) {
      const bodyParams: Record<string, PrimitiveParam> = {};
      Object.entries(params).forEach(([key, value]) => {
        bodyParams[key] = value;
      });
      if (Object.keys(bodyParams).length > 0) {
        requestBody = requestBodyContentType?.includes("application/json")
          ? JSON.stringify(bodyParams)
          : new URLSearchParams(
              Object.entries(bodyParams)
                .filter(([, v]) => v !== undefined && v !== null)
                .map(([k, v]) => [k, String(v)]),
            ).toString();
      }
    }

    const finalUrl = new URL(url, baseUrl);
    queryParams.forEach((value, key) =>
      finalUrl.searchParams.append(key, value),
    );

    const response = await fetch(finalUrl.toString(), {
      method: upperMethod,
      headers,
      body: requestBody,
    });
    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text: `HTTP Error ${response.status}: ${responseText}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            typeof responseData === "string"
              ? responseData
              : JSON.stringify(responseData, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Execution error: ${message}` }],
      isError: true,
    };
  }
};

const getSchemaShape = (inputSchema: unknown): Record<string, z.ZodTypeAny> => {
  const schemaShape: Record<string, z.ZodTypeAny> = {};
  if (
    inputSchema &&
    typeof inputSchema === "object" &&
    "properties" in (inputSchema as Record<string, unknown>)
  ) {
    const schemaObj = inputSchema as Record<string, unknown>;
    const properties = (
      schemaObj.properties && typeof schemaObj.properties === "object"
        ? schemaObj.properties
        : {}
    ) as Record<string, unknown>;
    const required = Array.isArray(schemaObj.required)
      ? (schemaObj.required as string[])
      : [];

    const mapPrimitive = (
      typeVal: unknown,
      prop: Record<string, unknown>,
    ): z.ZodTypeAny | undefined => {
      const baseType = Array.isArray(typeVal) ? typeVal[0] : typeVal;
      if (typeof baseType !== "string") return undefined;
      switch (baseType) {
        case "string":
          return z.string();
        case "number":
          return z.number();
        case "integer":
          return z.number().int();
        case "boolean":
          return z.boolean();
        case "array": {
          const items = (prop as { items?: unknown }).items;
          if (items && typeof items === "object" && !Array.isArray(items)) {
            const itemType =
              mapPrimitive(
                (items as Record<string, unknown>).type,
                items as Record<string, unknown>,
              ) || z.unknown();
            return z.array(itemType);
          }
          return z.array(z.unknown());
        }
        case "object":
          return z.record(z.string(), z.unknown());
        default:
          return undefined;
      }
    };

    Object.entries(properties).forEach(([key, prop]) => {
      if (typeof prop !== "object" || prop === null) return;
      let zodField: z.ZodTypeAny | undefined;
      const propObj = prop as Record<string, unknown>;

      if (Array.isArray(propObj.enum) && propObj.enum.length > 0) {
        const enumVals = propObj.enum as Array<string | number>;
        if (enumVals.every((v) => typeof v === "string")) {
          zodField = z.enum(enumVals as [string, ...string[]]);
        } else {
          const literals = enumVals.map((v) => z.literal(v as never));
          if (literals.length === 1) {
            zodField = literals[0];
          } else {
            let unionSchema: z.ZodTypeAny = z.union([literals[0], literals[1]]);
            for (let i = 2; i < literals.length; i++) {
              unionSchema = z.union([unionSchema, literals[i]]);
            }
            zodField = unionSchema;
          }
        }
      }
      if (!zodField) zodField = mapPrimitive(propObj.type, propObj);
      if (!zodField) return;
      if (propObj.description)
        zodField = zodField.describe(String(propObj.description));
      schemaShape[key] = required.includes(key)
        ? zodField
        : zodField.optional();
    });
  }
  return schemaShape;
};

const handler = (url: string) => {
  let serverMetadata = { name: "OpenAPI MCP Server", version: "0.0.1" };

  return createMcpHandler(
    async (server) => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const spec = (await res.json()) as OpenAPIV3.Document;
          const firstServer = spec.servers?.[0];
          serverMetadata.name =
            firstServer &&
            "name" in firstServer &&
            typeof firstServer.name === "string"
              ? firstServer.name
              : spec.info?.title || serverMetadata.name;
          serverMetadata.version = spec.info?.version || serverMetadata.version;
        }
      } catch {
        /* keep defaults */
      }

      const tools = await getToolsFromOpenApi(url, { dereference: true });

      tools.forEach((tool) => {
        const t = tool as ToolWithBaseUrl;
        let paramsSchema = getSchemaShape(t.inputSchema);
        if (Object.keys(paramsSchema).length === 0) {
          paramsSchema = { _: z.string().optional().describe("No parameters") };
        }

        if (Array.isArray(t.parameters)) {
          (t.parameters as ReadonlyArray<OpenAPIV3.ParameterObject>).forEach(
            (p) => {
              if (!p || !p.name || paramsSchema[p.name]) return;
              let field: z.ZodTypeAny = z.string();
              const schema = p.schema as OpenAPIV3.SchemaObject | undefined;
              if (schema?.type === "integer" || schema?.type === "number")
                field = z.number();
              else if (schema?.type === "boolean") field = z.boolean();
              if (p.description) field = field.describe(p.description);
              paramsSchema[p.name] = p.required ? field : field.optional();
            },
          );
        }

        const execParams = buildExecutionParams(t);
        server.tool(
          t.name,
          t.description || "",
          { ...paramsSchema },
          async (args, extra) => {
            const originalHeaders = normalizeHeaders(
              extra?.requestInfo &&
                (extra.requestInfo as unknown as { headers?: unknown }).headers,
            );
            return executeDynamicTool({
              name: t.name,
              method: t.method,
              baseUrl: t.baseUrl || "",
              pathTemplate: t.pathTemplate,
              parameters: execParams,
              requestBodyContentType: t.requestBodyContentType,
              params: (args as unknown as ParamsMap) ?? {},
              originalHeaders,
            });
          },
        );
      });
    },
    {
      serverInfo: {
        name: serverMetadata.name,
        version: serverMetadata.version,
      },
    },
  );
};

app.get("/", (c) => c.text("Stexio API Bridge — OpenAPI to MCP"));

app.get("/inspect-mcp", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.text("Missing url parameter", 400);
  const tools = await getToolsFromOpenApi(url, { dereference: true });
  return c.json({ url, tools }, 200);
});

app.all("/*", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.text("Missing url parameter", 400);
  return handler(url)(c.req.raw);
});

const port = await getPort({
  port: process.env.PORT ? Number(process.env.PORT) : 3001,
});
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`Stexio API bridge running on http://0.0.0.0:${info.port}`);
});
