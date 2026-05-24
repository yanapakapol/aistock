import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOnMcp, type McpServerLike } from './adapters/mcp';
import { TOOLS } from './tools';

/**
 * Builds a fresh McpServer with every tool in `TOOLS` registered. The
 * server is stateless aside from the registrations; one instance per
 * mcp-handler invocation is fine.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: 'aistock',
    version: '0.0.1',
  });

  for (const handler of TOOLS) {
    // McpServer satisfies McpServerLike — registerTool signature matches.
    registerOnMcp(server as unknown as McpServerLike, handler);
  }

  return server;
}
