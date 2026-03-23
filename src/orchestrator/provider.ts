/**
 * Model-Agnostic Provider Abstraction
 *
 * Pattern: Strategy + Factory
 *
 * This module implements a provider abstraction layer that decouples the
 * orchestration system from any specific LLM vendor. Each provider implements
 * a common interface, and the system can switch between providers at runtime
 * based on configuration, availability, or fallback policies.
 *
 * Architecture Decision: We use a normalized message format internally and
 * transform to/from provider-specific formats at the boundary. This ensures
 * the rest of the system never needs to know which provider is active.
 *
 * @see docs/adr/001-model-agnostic-design.md
 */

import type {
  Message,
  ModelConfig,
  ProviderCredentials,
  ProviderName,
  TokenUsage,
  ToolDefinition,
  StreamEvent,
  Logger,
} from '../types/index.js';

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface ProviderResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: unknown;
  }>;
  finishReason: 'stop' | 'tool_calls' | 'max_tokens' | 'error';
  usage: TokenUsage;
}

export interface LLMProvider {
  readonly name: ProviderName;

  /**
   * Send a completion request to the model.
   * Returns the full response after generation completes.
   */
  complete(
    messages: Message[],
    config: ModelConfig,
    tools?: ProviderToolDef[]
  ): Promise<ProviderResponse>;

  /**
   * Stream a completion request.
   * Yields incremental events as the model generates.
   */
  stream(
    messages: Message[],
    config: ModelConfig,
    tools?: ProviderToolDef[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;

  /**
   * Check if this provider is available (has valid credentials).
   */
  isAvailable(): boolean;
}

/**
 * Provider-agnostic tool definition.
 * Transformed from our internal ToolDefinition at the provider boundary.
 */
export interface ProviderToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ─── Provider Implementations ───────────────────────────────────────────────

/**
 * OpenAI-compatible provider.
 * Works with OpenAI API, Azure OpenAI, and any OpenAI-compatible endpoint.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name: ProviderName = 'openai';
  private credentials: ProviderCredentials;
  private logger: Logger;

  constructor(credentials: ProviderCredentials, logger: Logger) {
    this.credentials = credentials;
    this.logger = logger;
  }

  isAvailable(): boolean {
    return Boolean(this.credentials.apiKey);
  }

  async complete(
    messages: Message[],
    config: ModelConfig,
    tools?: ProviderToolDef[]
  ): Promise<ProviderResponse> {
    this.logger.debug('OpenAI complete request', {
      model: config.model,
      messageCount: messages.length,
      hasTools: Boolean(tools?.length),
    });

    const body: Record<string, unknown> = {
      model: config.model,
      messages: messages.map(toOpenAIMessage),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
    };

    if (tools?.length) {
      body.tools = tools.map(toOpenAITool);
      body.tool_choice = 'auto';
    }

    if (config.stopSequences?.length) {
      body.stop = config.stopSequences;
    }

    const response = await this.request('/chat/completions', body);
    return this.parseResponse(response);
  }

  async *stream(
    messages: Message[],
    config: ModelConfig,
    tools?: ProviderToolDef[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: messages.map(toOpenAIMessage),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? 4096,
      stream: true,
    };

    if (tools?.length) {
      body.tools = tools.map(toOpenAITool);
      body.tool_choice = 'auto';
    }

    let sequenceId = 0;
    let accumulated = '';

    // Simulate streaming with chunked response
    // In production, this would use fetch() with ReadableStream
    const response = await this.request('/chat/completions', body, signal);
    const content = response?.choices?.[0]?.message?.content ?? '';

    // Yield text in chunks to simulate streaming behavior
    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      accumulated += chunk;
      yield {
        type: 'text',
        data: { content: chunk, accumulated },
        timestamp: Date.now(),
        sequenceId: sequenceId++,
      };
    }

    yield {
      type: 'done',
      data: {
        tokenUsage: {
          promptTokens: response?.usage?.prompt_tokens ?? 0,
          completionTokens: response?.usage?.completion_tokens ?? 0,
          totalTokens: response?.usage?.total_tokens ?? 0,
        },
        duration: 0,
      },
      timestamp: Date.now(),
      sequenceId: sequenceId++,
    };
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, any>> {
    const baseUrl = this.credentials.baseUrl ?? 'https://api.openai.com/v1';
    const url = `${baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.credentials.apiKey}`,
    };

    if (this.credentials.organization) {
      headers['OpenAI-Organization'] = this.credentials.organization;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ProviderError(
        this.name,
        `HTTP ${response.status}: ${error}`,
        response.status
      );
    }

    return (await response.json()) as Record<string, any>;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private parseResponse(response: Record<string, any>): ProviderResponse {
    const choice = response.choices?.[0];
    const message = choice?.message;

    return {
      content: message?.content ?? '',
      toolCalls: message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })),
      finishReason: this.mapFinishReason(choice?.finish_reason),
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  private mapFinishReason(
    reason: string
  ): ProviderResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_calls';
      case 'length':
        return 'max_tokens';
      default:
        return 'error';
    }
  }
}

/**
 * Anthropic Claude provider.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name: ProviderName = 'anthropic';
  private credentials: ProviderCredentials;
  private logger: Logger;

  constructor(credentials: ProviderCredentials, logger: Logger) {
    this.credentials = credentials;
    this.logger = logger;
  }

  isAvailable(): boolean {
    return Boolean(this.credentials.apiKey);
  }

  async complete(
    messages: Message[],
    config: ModelConfig,
    tools?: ProviderToolDef[]
  ): Promise<ProviderResponse> {
    this.logger.debug('Anthropic complete request', {
      model: config.model,
      messageCount: messages.length,
    });

    const { system, conversationMessages } = extractSystemMessage(messages);

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      messages: conversationMessages.map(toAnthropicMessage),
    };

    if (system) {
      body.system = system;
    }

    if (config.temperature !== undefined) {
      body.temperature = config.temperature;
    }

    if (tools?.length) {
      body.tools = tools.map(toAnthropicTool);
    }

    const response = await this.request('/messages', body);
    return this.parseResponse(response);
  }

  async *stream(
    messages: Message[],
    config: ModelConfig,
    tools?: ProviderToolDef[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const { system, conversationMessages } = extractSystemMessage(messages);

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens ?? 4096,
      messages: conversationMessages.map(toAnthropicMessage),
      stream: true,
    };

    if (system) body.system = system;
    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (tools?.length) body.tools = tools.map(toAnthropicTool);

    let sequenceId = 0;
    let accumulated = '';

    const response = await this.request('/messages', body, signal);
    const content =
      response?.content
        ?.filter((b: Record<string, string>) => b.type === 'text')
        .map((b: Record<string, string>) => b.text)
        .join('') ?? '';

    const chunkSize = 20;
    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      accumulated += chunk;
      yield {
        type: 'text',
        data: { content: chunk, accumulated },
        timestamp: Date.now(),
        sequenceId: sequenceId++,
      };
    }

    yield {
      type: 'done',
      data: {
        tokenUsage: {
          promptTokens: response?.usage?.input_tokens ?? 0,
          completionTokens: response?.usage?.output_tokens ?? 0,
          totalTokens:
            (response?.usage?.input_tokens ?? 0) +
            (response?.usage?.output_tokens ?? 0),
        },
        duration: 0,
      },
      timestamp: Date.now(),
      sequenceId: sequenceId++,
    };
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, any>> {
    const baseUrl =
      this.credentials.baseUrl ?? 'https://api.anthropic.com/v1';
    const url = `${baseUrl}${path}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.credentials.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ProviderError(
        this.name,
        `HTTP ${response.status}: ${error}`,
        response.status
      );
    }

    return (await response.json()) as Record<string, any>;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private parseResponse(response: Record<string, any>): ProviderResponse {
    const textBlocks = response.content?.filter(
      (b: any) => b.type === 'text'
    );
    const toolBlocks = response.content?.filter(
      (b: any) => b.type === 'tool_use'
    );

    return {
      content: textBlocks?.map((b: any) => b.text).join('') ?? '',
      toolCalls: toolBlocks?.map((b: any) => ({
        id: b.id,
        name: b.name,
        input: b.input,
      })),
      finishReason:
        response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
      usage: {
        promptTokens: response.usage?.input_tokens ?? 0,
        completionTokens: response.usage?.output_tokens ?? 0,
        totalTokens:
          (response.usage?.input_tokens ?? 0) +
          (response.usage?.output_tokens ?? 0),
      },
    };
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ─── Provider Factory ───────────────────────────────────────────────────────

export class ProviderFactory {
  private providers = new Map<ProviderName, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: ProviderName): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get the first available provider from a priority list.
   * Implements the fallback chain pattern.
   */
  getAvailable(priority: ProviderName[]): LLMProvider | undefined {
    for (const name of priority) {
      const provider = this.providers.get(name);
      if (provider?.isAvailable()) {
        return provider;
      }
    }
    return undefined;
  }

  listAvailable(): ProviderName[] {
    return Array.from(this.providers.entries())
      .filter(([_, p]) => p.isAvailable())
      .map(([name]) => name);
  }
}

// ─── Provider Error ─────────────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderName,
    message: string,
    public readonly statusCode?: number
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }

  get isRetryable(): boolean {
    if (!this.statusCode) return true;
    return this.statusCode === 429 || this.statusCode >= 500;
  }
}

// ─── Message Format Transformers ────────────────────────────────────────────

function toOpenAIMessage(
  msg: Message
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) result.name = msg.name;
  if (msg.toolCallId) result.tool_call_id = msg.toolCallId;

  if (msg.toolCalls?.length) {
    result.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input),
      },
    }));
  }

  return result;
}

function toAnthropicMessage(
  msg: Message
): Record<string, unknown> {
  return {
    role: msg.role === 'tool' ? 'user' : msg.role,
    content: msg.toolCallId
      ? [
          {
            type: 'tool_result',
            tool_use_id: msg.toolCallId,
            content: msg.content,
          },
        ]
      : msg.content,
  };
}

function toOpenAITool(
  tool: ProviderToolDef
): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toAnthropicTool(
  tool: ProviderToolDef
): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function extractSystemMessage(messages: Message[]): {
  system: string | undefined;
  conversationMessages: Message[];
} {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  return {
    system: systemMessages.map((m) => m.content).join('\n') || undefined,
    conversationMessages,
  };
}

// ─── Utility: Transform internal tool defs to provider format ───────────────

export function toProviderToolDefs(
  tools: ToolDefinition[]
): ProviderToolDef[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.inputSchema),
  }));
}

/**
 * Minimal Zod-to-JSON-Schema converter.
 * Handles the common cases for tool parameter definitions.
 */
function zodToJsonSchema(schema: import('zod').ZodType): Record<string, unknown> {
  const description = schema.description;
  const def = (schema as any)._def;

  if (!def) return { type: 'object', properties: {} };

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as import('zod').ZodType);
        if (!(value as any).isOptional()) {
          required.push(key);
        }
      }

      const result: Record<string, unknown> = {
        type: 'object',
        properties,
      };
      if (required.length) result.required = required;
      if (description) result.description = description;
      return result;
    }

    case 'ZodString':
      return { type: 'string', ...(description ? { description } : {}) };

    case 'ZodNumber':
      return { type: 'number', ...(description ? { description } : {}) };

    case 'ZodBoolean':
      return { type: 'boolean', ...(description ? { description } : {}) };

    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJsonSchema(def.type),
        ...(description ? { description } : {}),
      };

    case 'ZodEnum':
      return {
        type: 'string',
        enum: def.values,
        ...(description ? { description } : {}),
      };

    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);

    default:
      return { type: 'string', ...(description ? { description } : {}) };
  }
}
