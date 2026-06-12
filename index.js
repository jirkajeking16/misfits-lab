#!/usr/bin/env node
/** Misfits Lab — stdio entry point (Claude Desktop) */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./tools.js";

const server = buildServer();
await server.connect(new StdioServerTransport());
console.error("Misfits Lab MCP server running (stdio)");
