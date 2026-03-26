import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  ToolRegistry,
  defineTool,
  ToolNotFoundError,
  ToolInputValidationError,
  ToolRegistryError,
} from '../tools/registry.js';
import type { Logger } from '../types/index.js';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockContext = {
  requestId: 'test-req-1',
  conversationId: 'test-conv-1',
  logger: mockLogger,
};

const addTool = defineTool({
  name: 'math.add',
  description: 'Add two numbers',
  inputSchema: z.object({
    a: z.number(),
    b: z.number(),
  }),
  outputSchema: z.object({
    result: z.number(),
  }),
  execute: async (input) => ({
    result: input.a + input.b,
  }),
});

const failingTool = defineTool({
  name: 'always_fail',
  description: 'Always fails',
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => {
    throw new Error('Intentional failure');
  },
  retryPolicy: { maxRetries: 1, backoffMs: 10, backoffMultiplier: 1 },
});

describe('ToolRegistry', () => {
  it('should register and execute a tool', async () => {
    const registry = new ToolRegistry(mockLogger);
    registry.register(addTool);

    const result = await registry.execute('math.add', { a: 2, b: 3 }, mockContext);
    expect(result).toEqual({ result: 5 });
  });

  it('should throw on duplicate registration', () => {
    const registry = new ToolRegistry(mockLogger);
    registry.register(addTool);

    expect(() => registry.register(addTool)).toThrow(ToolRegistryError);
  });

  it('should throw ToolNotFoundError for unknown tools', async () => {
    const registry = new ToolRegistry(mockLogger);

    await expect(
      registry.execute('nonexistent', {}, mockContext)
    ).rejects.toThrow(ToolNotFoundError);
  });

  it('should validate input and reject invalid data', async () => {
    const registry = new ToolRegistry(mockLogger);
    registry.register(addTool);

    await expect(
      registry.execute('math.add', { a: 'not a number', b: 3 }, mockContext)
    ).rejects.toThrow(ToolInputValidationError);
  });

  it('should retry on transient failures', async () => {
    const registry = new ToolRegistry(mockLogger);
    let callCount = 0;

    const flakyTool = defineTool({
      name: 'flaky',
      description: 'Fails once then succeeds',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => {
        callCount++;
        if (callCount === 1) throw new Error('Transient error');
        return { ok: true };
      },
      retryPolicy: { maxRetries: 2, backoffMs: 10, backoffMultiplier: 1 },
    });

    registry.register(flakyTool);
    const result = await registry.execute('flaky', {}, mockContext);
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it('should fail after max retries exceeded', async () => {
    const registry = new ToolRegistry(mockLogger);
    registry.register(failingTool);

    await expect(
      registry.execute('always_fail', {}, mockContext)
    ).rejects.toThrow('Failed after 2 attempts');
  });

  it('should list all registered tools', () => {
    const registry = new ToolRegistry(mockLogger);
    registry.register(addTool);
    registry.register(failingTool);

    const tools = registry.listTools();
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name)).toContain('math.add');
    expect(tools.map((t) => t.name)).toContain('always_fail');
  });

  it('should support unregistering tools', () => {
    const registry = new ToolRegistry(mockLogger);
    registry.register(addTool);

    expect(registry.has('math.add')).toBe(true);
    registry.unregister('math.add');
    expect(registry.has('math.add')).toBe(false);
  });

  it('should respect abort signal', async () => {
    const registry = new ToolRegistry(mockLogger);

    const slowTool = defineTool({
      name: 'slow',
      description: 'Takes a long time',
      inputSchema: z.object({}),
      outputSchema: z.object({ done: z.boolean() }),
      execute: async (_input, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { done: true };
      },
      timeout: 100, // 100ms timeout
    });

    registry.register(slowTool);

    await expect(
      registry.execute('slow', {}, mockContext)
    ).rejects.toThrow('Timed out');
  });
});
