/**
 * The list of MCP servers every session gets (`HUNT_MCP_SERVERS`, `apps/session/mcp-servers.json`), which the relay
 * (`relay.service.ts`) passes to the adapter when it creates or loads the session.
 */
import { readFileSync } from "node:fs";
import { McpServer } from "./mcp-server.value-object.ts";

/** Parses the list of MCP servers every session gets (`HUNT_MCP_SERVERS`), a JSON array of stdio entries. */
export function parseMcpServers(text: string): McpServer[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("expected a JSON array");
  return raw.map((entry: unknown, index) => McpServer.fromEntry(entry, `[${index}]`));
}

/** The MCP servers listed in the file at `path`; none without a path. */
export function readMcpServers(path: string | undefined): McpServer[] {
  if (!path) return [];
  try {
    return parseMcpServers(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${path}: ${(error as Error).message}`);
  }
}
