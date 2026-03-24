/**
 * Tool Registry & Execution Engine
 *
 * Pattern: Registry + Zod-Validated Tool Definitions
 *
 * Tools are the mechanism through which the AI model interacts with
 * the outside world. Each tool has:
 * - A Zod schema for input validation (type-safe at runtime)
 * - A Zod schema for output validation (contract enforcement)
 * - An execution function with timeout and abort support
 * - Optional retry policy for transient failures
 *
 * The registry validates all I/O at the boundary, ensuring that
 * neither the AI nor the tool implementation can violate the contract.
 *
 * @see docs/adr/004-tool-calling-architecture.md
 */

import { z, type ZodType } from 'zod';
import type {
  ToolDefinition,
  ToolExecutionContext,
  RetryPolicy,
  Logger,
} from '../types/index.js';

// ─── Default Policies ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30_000; // 30 seconds

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  backoffMs: 1000,
  backoffMultiplier: 2,
};

// ─── Tool Registry ──────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a tool with validated input/output schemas.
   */
  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new ToolRegistryError(
        `Tool "${tool.name}" is already registered`
      );
    }

    // Validate that schemas are valid Zod types
    if (!(tool.inputSchema instanceof z.ZodType)) {
      throw new ToolRegistryError(
        `Tool "${tool.name}" has invalid input schema — must be a Zod type`
      );
    }

    this.tools.set(tool.name, tool as ToolDefinition);
    this.logger.debug('tool.registered', { name: tool.name });
  }

  /**
   * Unregister a tool by name.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Execute a tool by name with full validation, timeout, and retry.
   */
  async execute(
    name: string,
    rawInput: unknown,
    context: ToolExecutionContext
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }

    // Step 1: Validate input
    const inputResult = tool.inputSchema.safeParse(rawInput);
    if (!inputResult.success) {
      throw new ToolInputValidationError(
        name,
        inputResult.error.format()
      );
    }

    const validatedInput = inputResult.data;
    const timeout = tool.timeout ?? DEFAULT_TIMEOUT;
    const retryPolicy = tool.retryPolicy ?? DEFAULT_RETRY_POLICY;

    // Step 2: Execute with retry and timeout
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
      if (context.abortSignal?.aborted) {
        throw new ToolExecutionError(name, 'Execution aborted');
      }

      if (attempt > 0) {
        const delay =
          retryPolicy.backoffMs *
          Math.pow(retryPolicy.backoffMultiplier, attempt - 1);

        this.logger.debug('tool.retry', {
          name,
          attempt,
          delay,
        });

        await sleep(delay);
      }

      try {
        const output = await withTimeout(
          tool.execute(validatedInput, context),
          timeout,
          name
        );

        // Step 3: Validate output
        const outputResult = tool.outputSchema.safeParse(output);
        if (!outputResult.success) {
          throw new ToolOutputValidationError(
            name,
            outputResult.error.format()
          );
        }

        return outputResult.data;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry non-retryable errors
        if (
          error instanceof ToolInputValidationError ||
          error instanceof ToolOutputValidationError
        ) {
          throw error;
        }

        // Check if error is retryable
        if (
          retryPolicy.retryableErrors?.length &&
          !retryPolicy.retryableErrors.some((re) =>
            lastError!.message.includes(re)
          )
        ) {
          throw error;
        }

        this.logger.warn('tool.execution_error', {
          name,
          attempt,
          error: lastError.message,
        });
      }
    }

    throw new ToolExecutionError(
      name,
      `Failed after ${retryPolicy.maxRetries + 1} attempts: ${lastError?.message}`
    );
  }

  /**
   * List all registered tools (for provider tool definition conversion).
   */
  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get a tool definition (for inspection, not execution).
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
}

// ─── Built-in Tool Definitions ──────────────────────────────────────────────

/**
 * Helper to create type-safe tool definitions.
 */
export function defineTool<TInput, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
  timeout?: number;
  retryPolicy?: RetryPolicy;
}): ToolDefinition<TInput, TOutput> {
  return config;
}

// ─── Common Built-in Tools ──────────────────────────────────────────────────

/**
 * Tree inspection tool — lets the AI read the current composition tree.
 */
export const inspectTreeTool = defineTool({
  name: 'inspect_tree',
  description:
    'Inspect the current composition tree. Returns the full tree or a subtree rooted at the specified UID.',
  inputSchema: z.object({
    rootUid: z
      .string()
      .optional()
      .describe('UID of the subtree root. Omit for full tree.'),
    maxDepth: z
      .number()
      .optional()
      .default(5)
      .describe('Maximum depth to traverse.'),
  }),
  outputSchema: z.object({
    tree: z.unknown(),
    nodeCount: z.number(),
  }),
  execute: async (_input, _context) => {
    // This would be connected to the actual tree store in a real implementation
    return {
      tree: { uid: 'root', type: 'root', slots: {} },
      nodeCount: 1,
    };
  },
});

/**
 * Schema lookup tool — lets the AI query available component schemas.
 */
export const lookupSchemaTool = defineTool({
  name: 'lookup_schema',
  description:
    'Look up the schema for a component type. Returns prop definitions, slot definitions, and usage guidance.',
  inputSchema: z.object({
    componentType: z.string().describe('The component type to look up.'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    schema: z.unknown().optional(),
  }),
  execute: async (_input, _context) => {
    // Connected to the registry in a real implementation
    return { found: false, schema: undefined };
  },
});

/**
 * Validate changes tool — lets the AI validate proposed changes before applying.
 */
export const validateChangesTool = defineTool({
  name: 'validate_changes',
  description:
    'Validate a set of proposed changes against the current tree state and schema. Returns validation errors without applying changes.',
  inputSchema: z.object({
    changes: z.array(
      z.object({
        operation: z.enum(['add', 'modify', 'remove', 'move']),
        targetUid: z.string().optional(),
        parentUid: z.string().optional(),
        slotId: z.string().optional(),
        node: z.unknown().optional(),
      })
    ),
  }),
  outputSchema: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  execute: async (_input, _context) => {
    // Connected to the validation system in a real implementation
    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  },
});

// ─── Error Types ────────────────────────────────────────────────────────────

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool "${toolName}" not found in registry`);
    this.name = 'ToolNotFoundError';
  }
}

export class ToolInputValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly details: unknown
  ) {
    super(
      `Input validation failed for tool "${toolName}": ${JSON.stringify(details)}`
    );
    this.name = 'ToolInputValidationError';
  }
}

export class ToolOutputValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly details: unknown
  ) {
    super(
      `Output validation failed for tool "${toolName}": ${JSON.stringify(details)}`
    );
    this.name = 'ToolOutputValidationError';
  }
}

export class ToolExecutionError extends Error {
  constructor(
    public readonly toolName: string,
    message: string
  ) {
    super(`Tool "${toolName}" execution failed: ${message}`);
    this.name = 'ToolExecutionError';
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ToolExecutionError(toolName, `Timed out after ${ms}ms`)
      );
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
