/**
 * AI Orchestration Playbook
 *
 * A reference implementation of production AI orchestration patterns.
 * Schema-guided generation, multi-provider LLM abstraction, agent loops
 * with tool calling, and multi-layer output validation.
 *
 * @author Ankita Dodamani
 * @license MIT
 */

// Pipeline (primary public API)
export { GenerationPipeline, PipelineError, type PipelineConfig } from './pipeline/index.js';

// Orchestration
export {
  Orchestrator,
  OrchestrationError,
  ProviderFactory,
  OpenAIProvider,
  AnthropicProvider,
  ProviderError,
  buildSystemPrompt,
  buildUserMessage,
  type OrchestratorConfig,
  type LLMProvider,
  type ProviderResponse,
  type ProviderToolDef,
} from './orchestrator/index.js';

// Schema
export {
  ComponentRegistryImpl,
  SchemaRegistryError,
  type TreeValidationResult,
} from './schema/index.js';

// Tools
export {
  ToolRegistry,
  defineTool,
  inspectTreeTool,
  lookupSchemaTool,
  validateChangesTool,
  ToolRegistryError,
  ToolNotFoundError,
  ToolInputValidationError,
  ToolOutputValidationError,
  ToolExecutionError,
} from './tools/index.js';

// Validation
export {
  ValidationPipeline,
  promptInjectionGuardrail,
  computeNodeChecksum,
  computeSlotChecksum,
} from './validation/index.js';

// Streaming
export {
  StreamProcessor,
  StreamBuilder,
  StreamError,
  type StreamProcessorOptions,
  type StreamSummary,
} from './streaming/index.js';

// Types (re-export everything)
export type * from './types/index.js';
