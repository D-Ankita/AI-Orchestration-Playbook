/**
 * AI Orchestration Engine
 *
 * Pattern: Agentic Loop with Tool-Calling
 *
 * This is the core orchestration engine that manages the multi-turn
 * interaction between the AI model and the tool system. It implements
 * the "agent loop" pattern:
 *
 *   User Prompt → Build Context → AI Call → Tool Calls? → Execute Tools
 *        ↑                                                     │
 *        └─────────────────── Loop ────────────────────────────┘
 *
 * Key design decisions:
 * - Conversation persistence: maintains full message history
 * - Checksum-based state verification before applying changes
 * - Ordered operation execution (REMOVE → MODIFY → ADD)
 * - Abort support at every stage via AbortSignal
 *
 * @see docs/adr/002-agentic-loop-design.md
 */

import type {
  Message,
  ModelConfig,
  GenerationRequest,
  GenerationResult,
  NodeChange,
  ToolCall,
  TokenUsage,
  Logger,
  StreamEvent,
} from '../types/index.js';
import {
  ProviderFactory,
  toProviderToolDefs,
  type LLMProvider,
} from './provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildSystemPrompt, buildUserMessage } from './prompt-builder.js';

// ─── Orchestrator Configuration ─────────────────────────────────────────────

export interface OrchestratorConfig {
  defaultModel: ModelConfig;
  maxAgentIterations: number;
  conversationTTL: number; // ms
  enableThinking: boolean;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  defaultModel: {
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 4096,
  },
  maxAgentIterations: 10,
  conversationTTL: 30 * 60 * 1000, // 30 minutes
  enableThinking: false,
};

// ─── Conversation Store ─────────────────────────────────────────────────────

interface ConversationState {
  id: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

class ConversationStore {
  private conversations = new Map<string, ConversationState>();
  private ttl: number;

  constructor(ttl: number) {
    this.ttl = ttl;
  }

  getOrCreate(id: string): ConversationState {
    const existing = this.conversations.get(id);
    if (existing && Date.now() - existing.updatedAt < this.ttl) {
      return existing;
    }

    const state: ConversationState = {
      id,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.conversations.set(id, state);
    return state;
  }

  appendMessage(id: string, message: Message): void {
    const state = this.getOrCreate(id);
    state.messages.push(message);
    state.updatedAt = Date.now();
  }

  getMessages(id: string): Message[] {
    return this.getOrCreate(id).messages;
  }

  clear(id: string): void {
    this.conversations.delete(id);
  }

  /**
   * Remove expired conversations to prevent memory leaks.
   */
  gc(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, state] of this.conversations) {
      if (now - state.updatedAt > this.ttl) {
        this.conversations.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export class Orchestrator {
  private config: OrchestratorConfig;
  private providerFactory: ProviderFactory;
  private toolRegistry: ToolRegistry;
  private conversations: ConversationStore;
  private logger: Logger;

  constructor(
    providerFactory: ProviderFactory,
    toolRegistry: ToolRegistry,
    logger: Logger,
    config?: Partial<OrchestratorConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.providerFactory = providerFactory;
    this.toolRegistry = toolRegistry;
    this.conversations = new ConversationStore(this.config.conversationTTL);
    this.logger = logger;
  }

  /**
   * Execute a generation request through the full agentic pipeline.
   *
   * Flow:
   * 1. Build system prompt from schema context
   * 2. Build user message with current state
   * 3. Enter agent loop (AI → tools → AI → ...)
   * 4. Parse and validate changes
   * 5. Return ordered, checksummed results
   */
  async generate(
    request: GenerationRequest,
    conversationId?: string,
    signal?: AbortSignal
  ): Promise<GenerationResult> {
    const startTime = Date.now();
    const convId = conversationId ?? `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    this.logger.info('orchestrator.generate.start', {
      conversationId: convId,
      mode: request.options?.mode ?? 'generate',
      prompt: request.prompt.slice(0, 100),
    });

    // Step 1: Resolve the provider
    const model = request.options?.model ?? this.config.defaultModel;
    const provider = this.resolveProvider(model);

    // Step 2: Build messages
    const systemPrompt = buildSystemPrompt(request.context);
    const userMessage = buildUserMessage(request);

    const conversation = this.conversations.getOrCreate(convId);
    if (conversation.messages.length === 0) {
      conversation.messages.push({ role: 'system', content: systemPrompt });
    }
    this.conversations.appendMessage(convId, {
      role: 'user',
      content: userMessage,
    });

    // Step 3: Agent loop
    const tools = this.toolRegistry.listTools();
    const providerTools = toProviderToolDefs(tools);
    let totalUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    let iteration = 0;
    let finalContent = '';

    while (iteration < this.config.maxAgentIterations) {
      if (signal?.aborted) {
        throw new OrchestrationError('Generation aborted by user', 'ABORTED');
      }

      iteration++;
      this.logger.debug('orchestrator.agent_loop.iteration', {
        iteration,
        messageCount: this.conversations.getMessages(convId).length,
      });

      // Call the AI model
      const response = await provider.complete(
        this.conversations.getMessages(convId),
        model,
        providerTools
      );

      // Accumulate token usage
      totalUsage = mergeUsage(totalUsage, response.usage);

      // If model wants to call tools, execute them
      if (
        response.finishReason === 'tool_calls' &&
        response.toolCalls?.length
      ) {
        // Record the assistant's tool call message
        this.conversations.appendMessage(convId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            input: tc.input,
            status: 'pending' as const,
          })),
        });

        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const result = await this.executeToolCall(
            toolCall,
            convId,
            signal
          );

          // Feed the tool result back as a message
          this.conversations.appendMessage(convId, {
            role: 'tool',
            content: JSON.stringify(result.output ?? result.error),
            toolCallId: toolCall.id,
          });
        }

        // Continue the loop — AI will see tool results and decide next step
        continue;
      }

      // Model is done — capture final content
      finalContent = response.content;
      this.conversations.appendMessage(convId, {
        role: 'assistant',
        content: finalContent,
      });
      break;
    }

    if (iteration >= this.config.maxAgentIterations) {
      this.logger.warn('orchestrator.max_iterations_reached', {
        iterations: iteration,
      });
    }

    // Step 4: Parse the AI response into structured changes
    const { changes, explanation, confidence } =
      this.parseGenerationResponse(finalContent);

    // Step 5: Order changes (REMOVE → MODIFY → ADD)
    const orderedChanges = this.orderChanges(changes);

    const duration = Date.now() - startTime;
    this.logger.info('orchestrator.generate.complete', {
      conversationId: convId,
      changes: orderedChanges.length,
      iterations: iteration,
      duration,
      totalTokens: totalUsage.totalTokens,
    });

    return {
      changes: orderedChanges,
      explanation,
      confidence,
      tokenUsage: totalUsage,
      duration,
    };
  }

  /**
   * Stream a generation request, yielding events as they occur.
   */
  async *generateStream(
    request: GenerationRequest,
    conversationId?: string,
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const convId = conversationId ?? `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const model = request.options?.model ?? this.config.defaultModel;
    const provider = this.resolveProvider(model);

    const systemPrompt = buildSystemPrompt(request.context);
    const userMessage = buildUserMessage(request);

    const conversation = this.conversations.getOrCreate(convId);
    if (conversation.messages.length === 0) {
      conversation.messages.push({ role: 'system', content: systemPrompt });
    }
    this.conversations.appendMessage(convId, {
      role: 'user',
      content: userMessage,
    });

    const tools = this.toolRegistry.listTools();
    const providerTools = toProviderToolDefs(tools);

    yield* provider.stream(
      this.conversations.getMessages(convId),
      model,
      providerTools,
      signal
    );
  }

  /**
   * Clean up expired conversations.
   */
  cleanup(): number {
    return this.conversations.gc();
  }

  // ─── Private Methods ────────────────────────────────────────────────────

  private resolveProvider(model: ModelConfig): LLMProvider {
    // Try the requested provider first, then fall back
    const provider =
      this.providerFactory.get(model.provider) ??
      this.providerFactory.getAvailable([
        model.provider,
        'anthropic',
        'openai',
        'google',
      ]);

    if (!provider) {
      throw new OrchestrationError(
        `No available provider. Requested: ${model.provider}. ` +
          `Available: ${this.providerFactory.listAvailable().join(', ') || 'none'}`,
        'NO_PROVIDER'
      );
    }

    return provider;
  }

  private async executeToolCall(
    toolCall: { id: string; name: string; input: unknown },
    conversationId: string,
    signal?: AbortSignal
  ): Promise<ToolCall> {
    const startedAt = new Date();
    this.logger.debug('orchestrator.tool_call.start', {
      toolId: toolCall.id,
      toolName: toolCall.name,
    });

    try {
      const output = await this.toolRegistry.execute(toolCall.name, toolCall.input, {
        requestId: toolCall.id,
        conversationId,
        abortSignal: signal,
        logger: this.logger,
      });

      this.logger.debug('orchestrator.tool_call.success', {
        toolId: toolCall.id,
        toolName: toolCall.name,
        duration: Date.now() - startedAt.getTime(),
      });

      return {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        status: 'success',
        output,
        startedAt,
        completedAt: new Date(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error('orchestrator.tool_call.error', {
        toolId: toolCall.id,
        toolName: toolCall.name,
        error: errorMessage,
      });

      return {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        status: 'error',
        error: errorMessage,
        startedAt,
        completedAt: new Date(),
      };
    }
  }

  private parseGenerationResponse(content: string): {
    changes: NodeChange[];
    explanation: string;
    confidence: number;
  } {
    // Try to extract JSON from the response
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          changes: parsed.changes ?? [],
          explanation: parsed.explanation ?? content,
          confidence: parsed.confidence ?? 0.8,
        };
      } catch {
        // Fall through to text-only response
      }
    }

    // Try to find raw JSON object
    const rawJsonMatch = content.match(/\{[\s\S]*"changes"[\s\S]*\}/);
    if (rawJsonMatch) {
      try {
        const parsed = JSON.parse(rawJsonMatch[0]);
        return {
          changes: parsed.changes ?? [],
          explanation: parsed.explanation ?? content,
          confidence: parsed.confidence ?? 0.7,
        };
      } catch {
        // Fall through
      }
    }

    return {
      changes: [],
      explanation: content,
      confidence: 0.5,
    };
  }

  /**
   * Order changes to prevent dependency violations:
   * REMOVE first (prevents orphaned references)
   * MODIFY second (operates on stable tree)
   * ADD last (can reference newly-stable parents)
   * MOVE is treated as REMOVE + ADD internally
   */
  private orderChanges(changes: NodeChange[]): NodeChange[] {
    const order: Record<NodeChange['operation'], number> = {
      remove: 0,
      modify: 1,
      move: 2,
      add: 3,
    };

    return [...changes].sort(
      (a, b) => order[a.operation] - order[b.operation]
    );
  }
}

// ─── Error Types ────────────────────────────────────────────────────────────

export class OrchestrationError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'OrchestrationError';
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    estimatedCost:
      (a.estimatedCost ?? 0) + (b.estimatedCost ?? 0) || undefined,
  };
}
