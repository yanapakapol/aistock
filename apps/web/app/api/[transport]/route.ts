import { createMcpHandler } from 'mcp-handler';
import { registerOnMcp, type McpServerLike } from '@/lib/mcp/adapters/mcp';
import { TOOLS } from '@/lib/mcp/tools';

// `mcp-handler` runs the SDK MCP server inside a Next.js route. Streamable
// HTTP transport needs Node (the Edge runtime can't open stdio bridges or
// Buffer.from binary frames cleanly) and we allow up to 5 minutes for long
// tool calls (a research loop can chain many DB writes).
export const runtime = 'nodejs';
export const maxDuration = 300;

const handler = createMcpHandler(
  (server) => {
    for (const tool of TOOLS) {
      registerOnMcp(server as unknown as McpServerLike, tool);
    }
  },
  {
    serverInfo: { name: 'aistock', version: '0.0.1' },
  },
);

export { handler as GET, handler as POST, handler as DELETE };
