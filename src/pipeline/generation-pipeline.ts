/**
 * Structured Generation Pipeline
 *
 * Pattern: Pipeline with Composable Stages
 *
 * This is the high-level pipeline that ties together all subsystems:
 * schema registry, orchestrator, validation, and streaming.
 *
 * Pipeline stages:
 *   1. Input Validation (guardrails)
 *   2. Context Assembly (schema + state → prompt)
 *   3. Generation (orchestrator → AI → tool calls)
 *   4. Output Validation (schema conformance + safety)
 *   5. Change Application (ordered, checksummed)
 *
 * The pipeline is the primary public API. Application code should
 * interact with the pipeline, not individual subsystems.
 *
 * @see docs/adr/007-pipeline-design.md
 */

import type {
  GenerationRequest,
  GenerationResult,
  NodeDto,
  NodeChange,
  ModelConfig,
  Logger,
  StreamEvent,
  Plugin,
} from '../types/index.js';
import { Orchestrator, type OrchestratorConfig } from '../orchestrator/orchestrator.js';
import { ProviderFactory, OpenAIProvider, AnthropicProvider } from '../orchestrator/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { ComponentRegistryImpl } from '../schema/registry.js';
import { ValidationPipeline, computeNodeChecksum } from '../validation/guardrails.js';

// ─── Pipeline Configuration ─────────────────────────────────────────────────

export interface PipelineConfig {
  /** Model configuration */
  model: ModelConfig;
  /** Provider API keys */
  providers: {
    openai?: { apiKey: string; baseUrl?: string; organization?: string };
    anthropic?: { apiKey: string; baseUrl?: string };
    google?: { apiKey: string };
  };
  /** Orchestrator settings */
  orchestrator?: Partial<OrchestratorConfig>;
  /** Enable dry-run mode (validate but don't apply) */
  dryRun?: boolean;
  /** Custom logger */
  logger?: Logger;
}

// ─── Default Logger ─────────────────────────────────────────────────────────

const createDefaultLogger = (): Logger => ({
  debug: (msg, meta) =>
    console.debug(JSON.stringify({ level: 'debug', msg, ...meta, ts: new Date().toISOString() })),
  info: (msg, meta) =>
    console.info(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() })),
  warn: (msg, meta) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...meta, ts: new Date().toISOString() })),
  error: (msg, meta) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date().toISOString() })),
});

// ─── Generation Pipeline ────────────────────────────────────────────────────

export class GenerationPipeline {
  private orchestrator: Orchestrator;
  private componentRegistry: ComponentRegistryImpl;
  private toolRegistry: ToolRegistry;
  private validationPipeline: ValidationPipeline;
  private plugins: Plugin[] = [];
  private logger: Logger;
  private config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.logger = config.logger ?? createDefaultLogger();

    // Initialize subsystems
    this.componentRegistry = new ComponentRegistryImpl();
    this.toolRegistry = new ToolRegistry(this.logger);
    this.validationPipeline = new ValidationPipeline();

    // Set up providers
    const providerFactory = new ProviderFactory();

    if (config.providers.openai?.apiKey) {
      providerFactory.register(
        new OpenAIProvider(config.providers.openai, this.logger)
      );
    }

    if (config.providers.anthropic?.apiKey) {
      providerFactory.register(
        new AnthropicProvider(config.providers.anthropic, this.logger)
      );
    }

    // Initialize orchestrator
    this.orchestrator = new Orchestrator(
      providerFactory,
      this.toolRegistry,
      this.logger,
      config.orchestrator
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Get the component registry for schema registration.
   */
  get schema(): ComponentRegistryImpl {
    return this.componentRegistry;
  }

  /**
   * Get the tool registry for tool registration.
   */
  get tools(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Get the validation pipeline for adding custom guardrails.
   */
  get validation(): ValidationPipeline {
    return this.validationPipeline;
  }

  /**
   * Register a plugin that hooks into the pipeline lifecycle.
   */
  use(plugin: Plugin): void {
    this.plugins.push(plugin);
    this.logger.info('pipeline.plugin.registered', {
      name: plugin.name,
      version: plugin.version,
    });
  }

  /**
   * Execute the full generation pipeline.
   *
   * This is the main entry point for generating UI changes.
   */
  async generate(
    prompt: string,
    options?: {
      currentTree?: NodeDto;
      selectedNode?: string;
      pageData?: Record<string, unknown>;
      mode?: 'generate' | 'modify' | 'refine';
      conversationId?: string;
      signal?: AbortSignal;
    }
  ): Promise<GenerationResult> {
    const startTime = Date.now();

    this.logger.info('pipeline.generate.start', {
      prompt: prompt.slice(0, 100),
      mode: options?.mode ?? 'generate',
    });

    // Stage 1: Input validation
    const inputResult = await this.validationPipeline.validateInput(prompt, {
      conversationHistory: [],
      schemaContext: this.componentRegistry.toContext(),
      mode: 'input',
    });

    if (!inputResult.allowed) {
      throw new PipelineError(
        `Input blocked by guardrails: ${inputResult.reason}`,
        'INPUT_BLOCKED'
      );
    }

    // Stage 2: Build request
    let request: GenerationRequest = {
      prompt,
      context: {
        schema: this.componentRegistry.toContext(),
        currentTree: options?.currentTree,
        selectedNode: options?.selectedNode,
        pageData: options?.pageData,
      },
      options: {
        model: this.config.model,
        mode: options?.mode ?? 'generate',
        dryRun: this.config.dryRun,
      },
    };

    // Run beforeGeneration hooks
    for (const plugin of this.plugins) {
      if (plugin.hooks?.beforeGeneration) {
        request = await plugin.hooks.beforeGeneration(request);
      }
    }

    // Stage 3: Generate via orchestrator
    let result = await this.orchestrator.generate(
      request,
      options?.conversationId,
      options?.signal
    );

    // Stage 4: Validate output
    const validationResult = await this.validationPipeline.validateChanges(
      result.changes,
      this.componentRegistry.toContext(),
      options?.currentTree
    );

    if (!validationResult.valid) {
      this.logger.warn('pipeline.validation.failed', {
        errors: validationResult.errors,
      });

      // Filter out invalid changes, keep valid ones
      const validChanges = result.changes.filter((change, i) => {
        const hasError = validationResult.errors.some((e) =>
          e.path.includes(change.targetUid ?? change.parentUid ?? String(i))
        );
        return !hasError;
      });

      result = {
        ...result,
        changes: validChanges,
        confidence: result.confidence * 0.7, // Reduce confidence
      };
    }

    // Stage 5: Add checksums
    if (options?.currentTree) {
      result.changes = this.addChecksums(result.changes, options.currentTree);
    }

    // Run afterGeneration hooks
    for (const plugin of this.plugins) {
      if (plugin.hooks?.afterGeneration) {
        result = await plugin.hooks.afterGeneration(result);
      }
    }

    result.duration = Date.now() - startTime;

    this.logger.info('pipeline.generate.complete', {
      changes: result.changes.length,
      confidence: result.confidence,
      duration: result.duration,
      tokens: result.tokenUsage.totalTokens,
    });

    return result;
  }

  /**
   * Stream generation events in real-time.
   */
  async *generateStream(
    prompt: string,
    options?: {
      currentTree?: NodeDto;
      selectedNode?: string;
      mode?: 'generate' | 'modify' | 'refine';
      conversationId?: string;
      signal?: AbortSignal;
    }
  ): AsyncGenerator<StreamEvent> {
    // Input validation
    const inputResult = await this.validationPipeline.validateInput(prompt, {
      conversationHistory: [],
      schemaContext: this.componentRegistry.toContext(),
      mode: 'input',
    });

    if (!inputResult.allowed) {
      yield {
        type: 'error',
        data: {
          message: `Input blocked: ${inputResult.reason}`,
          code: 'INPUT_BLOCKED',
          recoverable: false,
        },
        timestamp: Date.now(),
        sequenceId: 0,
      };
      return;
    }

    const request: GenerationRequest = {
      prompt,
      context: {
        schema: this.componentRegistry.toContext(),
        currentTree: options?.currentTree,
        selectedNode: options?.selectedNode,
      },
      options: {
        model: this.config.model,
        mode: options?.mode ?? 'generate',
        streaming: true,
      },
    };

    yield* this.orchestrator.generateStream(
      request,
      options?.conversationId,
      options?.signal
    );
  }

  /**
   * Apply validated changes to a tree (immutable — returns new tree).
   */
  applyChanges(tree: NodeDto, changes: NodeChange[]): NodeDto {
    let result = structuredClone(tree);

    for (const change of changes) {
      switch (change.operation) {
        case 'add':
          result = this.applyAdd(result, change);
          break;
        case 'modify':
          result = this.applyModify(result, change);
          break;
        case 'remove':
          result = this.applyRemove(result, change);
          break;
        case 'move':
          // Move = remove + add
          result = this.applyRemove(result, {
            ...change,
            operation: 'remove',
          });
          result = this.applyAdd(result, {
            ...change,
            operation: 'add',
          });
          break;
      }
    }

    return result;
  }

  /**
   * Clean up resources.
   */
  cleanup(): void {
    this.orchestrator.cleanup();
  }

  // ─── Change Application ─────────────────────────────────────────────────

  private applyAdd(tree: NodeDto, change: NodeChange): NodeDto {
    if (!change.parentUid || !change.node) return tree;

    return this.mapTree(tree, (node) => {
      if (node.uid === change.parentUid) {
        const slotId = change.slotId ?? 'default';
        const slots = { ...node.slots };
        const children = [...(slots[slotId] ?? [])];
        const index = change.index ?? children.length;
        children.splice(index, 0, change.node!);
        slots[slotId] = children;
        return { ...node, slots };
      }
      return node;
    });
  }

  private applyModify(tree: NodeDto, change: NodeChange): NodeDto {
    if (!change.targetUid) return tree;

    return this.mapTree(tree, (node) => {
      if (node.uid === change.targetUid) {
        const updated = { ...node };

        if (change.props) {
          updated.props = { ...updated.props, ...change.props };
        }

        if (change.styles) {
          updated.styles = { ...updated.styles, ...change.styles };
        }

        return updated;
      }
      return node;
    });
  }

  private applyRemove(tree: NodeDto, change: NodeChange): NodeDto {
    if (!change.targetUid) return tree;

    return this.mapTree(tree, (node) => {
      if (node.slots) {
        const newSlots: Record<string, NodeDto[]> = {};
        for (const [slotId, children] of Object.entries(node.slots)) {
          newSlots[slotId] = children.filter(
            (child) => child.uid !== change.targetUid
          );
        }
        return { ...node, slots: newSlots };
      }
      return node;
    });
  }

  private mapTree(
    node: NodeDto,
    fn: (node: NodeDto) => NodeDto
  ): NodeDto {
    const mapped = fn(node);

    if (mapped.slots) {
      const newSlots: Record<string, NodeDto[]> = {};
      for (const [slotId, children] of Object.entries(mapped.slots)) {
        newSlots[slotId] = children.map((child) => this.mapTree(child, fn));
      }
      return { ...mapped, slots: newSlots };
    }

    return mapped;
  }

  private addChecksums(
    changes: NodeChange[],
    tree: NodeDto
  ): NodeChange[] {
    return changes.map((change) => {
      if (change.targetUid) {
        const targetNode = this.findNode(tree, change.targetUid);
        if (targetNode) {
          return {
            ...change,
            checksum: {
              before: computeNodeChecksum(targetNode),
              expectedAfter: 'pending', // Computed after application
            },
          };
        }
      }
      return change;
    });
  }

  private findNode(root: NodeDto, uid: string): NodeDto | undefined {
    if (root.uid === uid) return root;
    if (root.slots) {
      for (const children of Object.values(root.slots)) {
        for (const child of children) {
          const found = this.findNode(child, uid);
          if (found) return found;
        }
      }
    }
    return undefined;
  }
}

// ─── Pipeline Error ─────────────────────────────────────────────────────────

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
