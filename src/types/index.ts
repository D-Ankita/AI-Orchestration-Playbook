/**
 * Core type definitions for the AI Orchestration Playbook.
 *
 * These types define the contracts between all subsystems:
 * orchestration, schema parsing, tool execution, validation, and streaming.
 */

// ─── Provider & Model Types ─────────────────────────────────────────────────

export type ProviderName = 'openai' | 'anthropic' | 'google' | 'custom';

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  region?: string;
}

// ─── Message Types ──────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ConversationContext {
  conversationId: string;
  messages: Message[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Tool System Types ──────────────────────────────────────────────────────

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: import('zod').ZodType<TInput>;
  outputSchema: import('zod').ZodType<TOutput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
  timeout?: number;
  retryPolicy?: RetryPolicy;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  status: 'pending' | 'running' | 'success' | 'error';
  output?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ToolExecutionContext {
  requestId: string;
  conversationId: string;
  abortSignal?: AbortSignal;
  logger: Logger;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  retryableErrors?: string[];
}

// ─── Schema System Types ────────────────────────────────────────────────────

export interface ComponentSchema {
  type: string;
  displayName: string;
  description?: string;
  props: Record<string, PropDefinition>;
  slots?: Record<string, SlotDefinition>;
  category?: string;
  tags?: string[];
}

export interface PropDefinition {
  type: PropType;
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
  enum?: unknown[];
  validation?: import('zod').ZodType;
}

export type PropType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'richtext'
  | 'image'
  | 'link'
  | 'color'
  | 'enum';

export interface SlotDefinition {
  displayName: string;
  description?: string;
  allowedTypes?: string[];
  minChildren?: number;
  maxChildren?: number;
}

export interface ComponentRegistry {
  components: Map<string, ComponentSchema>;
  register(schema: ComponentSchema): void;
  get(type: string): ComponentSchema | undefined;
  list(filter?: ComponentFilter): ComponentSchema[];
  toContext(): SchemaContext;
}

export interface ComponentFilter {
  category?: string;
  tags?: string[];
  excludeSystem?: boolean;
}

// ─── Node Tree Types ────────────────────────────────────────────────────────

export interface NodeDto {
  uid: string;
  type: string;
  props?: Record<string, NodePropValue>;
  styles?: Record<string, string>;
  attrs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  slots?: Record<string, NodeDto[]>;
}

export interface NodePropValue {
  type: 'static' | 'bound' | 'expression';
  value: unknown;
  binding?: BindingConfig;
}

export interface BindingConfig {
  source: BindingSource;
  path: string;
  fallback?: unknown;
}

export type BindingSource =
  | 'static_value'
  | 'template'
  | 'data_source'
  | 'component_props'
  | 'repeater'
  | 'expression';

// ─── Schema Context (sent to AI) ───────────────────────────────────────────

export interface SchemaContext {
  components: ComponentSchemaCompact[];
  designTokens?: DesignTokens;
  constraints?: GenerationConstraints;
}

export interface ComponentSchemaCompact {
  type: string;
  displayName: string;
  props: Record<string, string>; // prop name → type description
  slots?: string[];
}

export interface DesignTokens {
  colors?: Record<string, string>;
  spacing?: Record<string, string>;
  typography?: Record<string, TypographyToken>;
  shadows?: Record<string, string>;
  borders?: Record<string, string>;
}

export interface TypographyToken {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
}

export interface GenerationConstraints {
  maxDepth?: number;
  maxChildren?: number;
  allowedComponentTypes?: string[];
  disallowedComponentTypes?: string[];
  stylePolicy?: 'tailwind' | 'css-variables' | 'inline' | 'none';
}

// ─── Pipeline Types ─────────────────────────────────────────────────────────

export interface GenerationRequest {
  prompt: string;
  context: GenerationContext;
  options?: GenerationOptions;
}

export interface GenerationContext {
  schema: SchemaContext;
  currentTree?: NodeDto;
  selectedNode?: string; // uid of the selected node
  conversationHistory?: Message[];
  pageData?: Record<string, unknown>;
}

export interface GenerationOptions {
  model?: ModelConfig;
  mode?: 'generate' | 'modify' | 'refine';
  streaming?: boolean;
  dryRun?: boolean;
  maxIterations?: number;
}

export interface GenerationResult {
  changes: NodeChange[];
  explanation: string;
  confidence: number;
  tokenUsage: TokenUsage;
  duration: number;
}

export interface NodeChange {
  operation: 'add' | 'modify' | 'remove' | 'move';
  targetUid?: string;
  parentUid?: string;
  slotId?: string;
  index?: number;
  node?: NodeDto;
  props?: Record<string, NodePropValue>;
  styles?: Record<string, string>;
  checksum?: ChangeChecksum;
}

export interface ChangeChecksum {
  before: string;
  expectedAfter: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost?: number;
}

// ─── Streaming Types ────────────────────────────────────────────────────────

export type StreamEventType =
  | 'text'
  | 'thinking'
  | 'tool_start'
  | 'tool_result'
  | 'change'
  | 'done'
  | 'error';

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  timestamp: number;
  sequenceId: number;
}

export interface TextStreamEvent extends StreamEvent {
  type: 'text';
  data: { content: string; accumulated: string };
}

export interface ThinkingStreamEvent extends StreamEvent {
  type: 'thinking';
  data: { content: string };
}

export interface ToolStartEvent extends StreamEvent {
  type: 'tool_start';
  data: { toolCallId: string; name: string; input: unknown };
}

export interface ToolResultEvent extends StreamEvent {
  type: 'tool_result';
  data: { toolCallId: string; output: unknown; isError: boolean };
}

export interface ChangeStreamEvent extends StreamEvent {
  type: 'change';
  data: { change: NodeChange };
}

export interface DoneStreamEvent extends StreamEvent {
  type: 'done';
  data: { tokenUsage: TokenUsage; duration: number };
}

export interface ErrorStreamEvent extends StreamEvent {
  type: 'error';
  data: { message: string; code: string; recoverable: boolean };
}

// ─── Validation Types ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  sanitizedOutput?: unknown;
}

export interface ValidationError {
  path: string;
  message: string;
  code: string;
  severity: 'error';
}

export interface ValidationWarning {
  path: string;
  message: string;
  code: string;
  severity: 'warning';
}

export type GuardrailCheck = (
  input: string,
  context: GuardrailContext
) => Promise<GuardrailResult>;

export interface GuardrailContext {
  conversationHistory: Message[];
  schemaContext: SchemaContext;
  mode: 'input' | 'output';
}

export interface GuardrailResult {
  allowed: boolean;
  reason?: string;
  sanitized?: string;
  risk: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

// ─── Logging ────────────────────────────────────────────────────────────────

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ─── Plugin System ──────────────────────────────────────────────────────────

export interface Plugin<TState = unknown> {
  name: string;
  version: string;
  initialize?: (context: PluginContext) => Promise<void>;
  hooks?: PluginHooks<TState>;
}

export interface PluginContext {
  logger: Logger;
  config: Record<string, unknown>;
}

export interface PluginHooks<TState = unknown> {
  beforeGeneration?: (request: GenerationRequest) => Promise<GenerationRequest>;
  afterGeneration?: (result: GenerationResult) => Promise<GenerationResult>;
  beforeToolExecution?: (call: ToolCall) => Promise<ToolCall>;
  afterToolExecution?: (call: ToolCall) => Promise<ToolCall>;
  transformState?: (state: TState) => TState;
}
