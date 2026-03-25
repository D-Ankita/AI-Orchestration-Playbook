/**
 * Streaming Inference Processor
 *
 * Pattern: NDJSON/SSE Stream Processing with Incremental State
 *
 * Handles real-time streaming from LLM providers, parsing incremental
 * events, managing backpressure, and supporting cancellation.
 *
 * The stream processor is provider-agnostic: it accepts a ReadableStream
 * of bytes and produces typed StreamEvents. This decouples the transport
 * layer from the business logic.
 *
 * Key patterns:
 * - NDJSON parsing with line buffering
 * - Incremental text accumulation
 * - Tool call tracking across multiple stream events
 * - Abort support via AbortController
 * - Backpressure management via configurable buffer
 *
 * @see docs/adr/006-streaming-architecture.md
 */

import EventEmitter from 'eventemitter3';
import type {
  StreamEvent,
  ToolCall,
  TokenUsage,
} from '../types/index.js';

// ─── Stream Processor ───────────────────────────────────────────────────────

export interface StreamProcessorOptions {
  /** Maximum buffer size before applying backpressure (bytes) */
  maxBufferSize?: number;
  /** Parse format: 'ndjson' (newline-delimited JSON) or 'sse' (Server-Sent Events) */
  format?: 'ndjson' | 'sse';
  /** Callback for each event */
  onEvent?: (event: StreamEvent) => void;
  /** Callback when stream completes */
  onComplete?: (summary: StreamSummary) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
}

export interface StreamSummary {
  totalEvents: number;
  textLength: number;
  toolCalls: ToolCall[];
  tokenUsage?: TokenUsage;
  duration: number;
  aborted: boolean;
}

export class StreamProcessor extends EventEmitter {
  private options: Required<StreamProcessorOptions>;
  private buffer = '';
  private sequenceId = 0;
  private accumulatedText = '';
  private activeToolCalls: Map<string, ToolCall> = new Map();
  private eventCount = 0;
  private startTime = 0;
  private abortController: AbortController | null = null;

  constructor(options?: StreamProcessorOptions) {
    super();
    this.options = {
      maxBufferSize: 1024 * 1024, // 1MB
      format: 'ndjson',
      onEvent: options?.onEvent ?? (() => {}),
      onComplete: options?.onComplete ?? (() => {}),
      onError: options?.onError ?? (() => {}),
    };
  }

  /**
   * Process a ReadableStream of bytes into typed events.
   */
  async processStream(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal
  ): Promise<StreamSummary> {
    this.startTime = Date.now();
    this.abortController = new AbortController();
    const decoder = new TextDecoder();

    // Link external abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        this.abortController?.abort();
      });
    }

    const reader = stream.getReader();

    try {
      while (true) {
        if (this.abortController.signal.aborted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        this.buffer += chunk;

        // Backpressure check
        if (this.buffer.length > this.options.maxBufferSize) {
          this.options.onError(
            new StreamError('Buffer overflow: stream producing data faster than consumption')
          );
          break;
        }

        // Process complete lines
        this.processBuffer();
      }

      // Process any remaining buffer
      if (this.buffer.trim()) {
        this.processLine(this.buffer.trim());
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        this.options.onError(error);
        this.emit('error', error);
      }
    } finally {
      reader.releaseLock();
    }

    const summary = this.buildSummary();
    this.options.onComplete(summary);
    this.emit('complete', summary);
    return summary;
  }

  /**
   * Process an async generator of StreamEvents directly.
   * Useful when the provider already returns parsed events.
   */
  async processAsyncGenerator(
    generator: AsyncGenerator<StreamEvent>,
    signal?: AbortSignal
  ): Promise<StreamSummary> {
    this.startTime = Date.now();

    try {
      for await (const event of generator) {
        if (signal?.aborted) break;

        this.handleEvent(event);
      }
    } catch (error) {
      if (error instanceof Error && error.name !== 'AbortError') {
        this.options.onError(error);
      }
    }

    const summary = this.buildSummary();
    this.options.onComplete(summary);
    this.emit('complete', summary);
    return summary;
  }

  /**
   * Abort the current stream processing.
   */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Get the accumulated text so far.
   */
  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  /**
   * Get all active/completed tool calls.
   */
  getToolCalls(): ToolCall[] {
    return Array.from(this.activeToolCalls.values());
  }

  // ─── Buffer Processing ──────────────────────────────────────────────────

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.processLine(trimmed);
    }
  }

  private processLine(line: string): void {
    let data: string;

    if (this.options.format === 'sse') {
      // Strip SSE prefix: "data: {...}"
      if (line.startsWith('data: ')) {
        data = line.slice(6);
      } else if (line.startsWith(':')) {
        // Comment line — ignore
        return;
      } else {
        data = line;
      }

      // SSE end signal
      if (data === '[DONE]') {
        return;
      }
    } else {
      // NDJSON — each line is a complete JSON object
      data = line;
    }

    try {
      const parsed = JSON.parse(data) as StreamEvent;
      this.handleEvent(parsed);
    } catch {
      // Ignore malformed lines — they may be partial
    }
  }

  // ─── Event Handling ─────────────────────────────────────────────────────

  private handleEvent(event: StreamEvent): void {
    this.eventCount++;
    event.sequenceId = this.sequenceId++;
    event.timestamp = event.timestamp || Date.now();

    switch (event.type) {
      case 'text':
        this.handleTextEvent(event);
        break;
      case 'thinking':
        this.emit('thinking', event);
        break;
      case 'tool_start':
        this.handleToolStart(event);
        break;
      case 'tool_result':
        this.handleToolResult(event);
        break;
      case 'change':
        this.emit('change', event);
        break;
      case 'done':
        this.emit('done', event);
        break;
      case 'error':
        this.emit('stream_error', event);
        break;
    }

    this.options.onEvent(event);
    this.emit('event', event);
  }

  private handleTextEvent(event: StreamEvent): void {
    const data = event.data as { content: string; accumulated?: string };
    this.accumulatedText += data.content;
    // Enrich event with accumulated text
    data.accumulated = this.accumulatedText;
    this.emit('text', event);
  }

  private handleToolStart(event: StreamEvent): void {
    const data = event.data as {
      toolCallId: string;
      name: string;
      input: unknown;
    };

    const toolCall: ToolCall = {
      id: data.toolCallId,
      name: data.name,
      input: data.input,
      status: 'running',
      startedAt: new Date(),
    };

    this.activeToolCalls.set(data.toolCallId, toolCall);
    this.emit('tool_start', event);
  }

  private handleToolResult(event: StreamEvent): void {
    const data = event.data as {
      toolCallId: string;
      output: unknown;
      isError: boolean;
    };

    const toolCall = this.activeToolCalls.get(data.toolCallId);
    if (toolCall) {
      toolCall.status = data.isError ? 'error' : 'success';
      toolCall.output = data.isError ? undefined : data.output;
      toolCall.error = data.isError ? String(data.output) : undefined;
      toolCall.completedAt = new Date();
    }

    this.emit('tool_result', event);
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  private buildSummary(): StreamSummary {
    const doneEvents = Array.from(this.activeToolCalls.values());

    return {
      totalEvents: this.eventCount,
      textLength: this.accumulatedText.length,
      toolCalls: doneEvents,
      duration: Date.now() - this.startTime,
      aborted: this.abortController?.signal.aborted ?? false,
    };
  }
}

// ─── Stream Builder (for creating streams) ──────────────────────────────────

/**
 * Build an NDJSON stream from events.
 * Useful for server-side streaming responses.
 */
export class StreamBuilder {
  private sequenceId = 0;

  createTextEvent(content: string, accumulated: string): StreamEvent {
    return {
      type: 'text',
      data: { content, accumulated },
      timestamp: Date.now(),
      sequenceId: this.sequenceId++,
    };
  }

  createThinkingEvent(content: string): StreamEvent {
    return {
      type: 'thinking',
      data: { content },
      timestamp: Date.now(),
      sequenceId: this.sequenceId++,
    };
  }

  createToolStartEvent(
    toolCallId: string,
    name: string,
    input: unknown
  ): StreamEvent {
    return {
      type: 'tool_start',
      data: { toolCallId, name, input },
      timestamp: Date.now(),
      sequenceId: this.sequenceId++,
    };
  }

  createToolResultEvent(
    toolCallId: string,
    output: unknown,
    isError = false
  ): StreamEvent {
    return {
      type: 'tool_result',
      data: { toolCallId, output, isError },
      timestamp: Date.now(),
      sequenceId: this.sequenceId++,
    };
  }

  createDoneEvent(tokenUsage: TokenUsage, duration: number): StreamEvent {
    return {
      type: 'done',
      data: { tokenUsage, duration },
      timestamp: Date.now(),
      sequenceId: this.sequenceId++,
    };
  }

  createErrorEvent(
    message: string,
    code: string,
    recoverable = false
  ): StreamEvent {
    return {
      type: 'error',
      data: { message, code, recoverable },
      timestamp: Date.now(),
      sequenceId: this.sequenceId++,
    };
  }

  /**
   * Serialize an event to NDJSON format.
   */
  serialize(event: StreamEvent): string {
    return JSON.stringify(event) + '\n';
  }

  /**
   * Serialize an event to SSE format.
   */
  serializeSSE(event: StreamEvent): string {
    return `data: ${JSON.stringify(event)}\n\n`;
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamError';
  }
}
