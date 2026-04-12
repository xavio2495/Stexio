// Agent 04 implements this file.
// Stub exists so TypeScript compiles.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { config } from "dotenv";

config();

const app = new Hono();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "stexio-proxy" }));

const port = Number(process.env.PORT ?? 3006);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Stexio proxy listening on port ${port}`);
});

export default app;
