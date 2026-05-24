import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { TOOLS } from '../tools';
import { toAiSdkTool } from '../adapters/aiSdk';
import { registerOnMcp, type McpServerLike } from '../adapters/mcp';

/**
 * Schema-only round trip. We don't execute any handler (that would touch
 * Postgres / Tavily) — we just confirm both adapters accept every tool's
 * schemas without throwing. CI tripwire for tool-handler drift (open
 * risk #1 in the plan).
 */

function makeFakeServer(): {
  server: McpServerLike;
  registered: Array<{ name: string; shape: Record<string, z.ZodTypeAny> }>;
} {
  const registered: Array<{ name: string; shape: Record<string, z.ZodTypeAny> }> = [];
  const server: McpServerLike = {
    registerTool(name, config) {
      registered.push({ name, shape: config.inputSchema });
    },
  };
  return { server, registered };
}

describe('mcp tool round-trip', () => {
  it('TOOLS is non-empty and names are unique', () => {
    assert.ok(TOOLS.length > 0, 'TOOLS should not be empty');
    const names = TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  });

  it('every tool exposes the required ToolHandler fields', () => {
    for (const t of TOOLS) {
      assert.equal(typeof t.name, 'string', `name on ${t.name}`);
      assert.ok(t.name.length > 0, `name on ${t.name}`);
      assert.equal(typeof t.description, 'string', `description on ${t.name}`);
      assert.ok(t.description.length > 0, `description on ${t.name}`);
      assert.equal(typeof t.execute, 'function', `execute on ${t.name}`);
      // ZodType instances expose `parse` and `safeParse`.
      assert.equal(typeof (t.input as unknown as { parse: unknown }).parse, 'function');
      assert.equal(typeof (t.output as unknown as { parse: unknown }).parse, 'function');
    }
  });

  it('toAiSdkTool wraps every handler without throwing', () => {
    for (const t of TOOLS) {
      const wrapped = toAiSdkTool(t);
      assert.ok(wrapped, `aiSdk wrap returned falsy for ${t.name}`);
    }
  });

  it('registerOnMcp accepts every handler without throwing', () => {
    const { server, registered } = makeFakeServer();
    for (const t of TOOLS) {
      registerOnMcp(server, t);
    }
    assert.equal(registered.length, TOOLS.length);
    // For ZodObject inputs the inputSchema should be the object's shape, not empty.
    for (const r of registered) {
      const tool = TOOLS.find((t) => t.name === r.name);
      assert.ok(tool, `registered tool ${r.name} not found in TOOLS`);
      const isObject = (tool.input as unknown as { _def?: { typeName?: string } })._def
        ?.typeName === 'ZodObject';
      if (isObject) {
        assert.ok(
          Object.keys(r.shape).length > 0,
          `expected non-empty shape for ${r.name} (ZodObject input)`,
        );
      }
    }
  });
});
