#!/usr/bin/env node
/** Misfits Lab — HTTP entry point (claude.ai web/mobile custom connector) */
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./tools.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.json({ ok: true, name: "Misfits Lab MCP", endpoint: "/mcp" }));

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error:", e);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// Stateless server: no SSE stream or sessions
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.error(`Misfits Lab MCP (HTTP) on :${port}/mcp`));
