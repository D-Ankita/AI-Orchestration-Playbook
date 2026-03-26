# 001: Model-Agnostic Provider Design

## Context

The ai-orchestration-playbook project must support multiple LLM providers—OpenAI, Anthropic, Google, and others—without creating vendor lock-in. Each provider implements different message formats, tool calling conventions, streaming protocols, and error handling strategies. Directly embedding provider-specific logic throughout the codebase creates maintenance burden and makes switching providers expensive.

## Decision

Adopt a **Strategy pattern with ProviderFactory** to abstract provider differences:

1. Define a unified `Message` interface (role, content) internally.
2. Each provider implements a `LLMProvider` interface with methods: `generateCompletion()`, `generateWithTools()`, `stream()`.
3. A `ProviderFactory` constructs provider instances based on configuration.
4. At provider boundaries, normalize internal messages to provider-specific formats and transform responses back to internal types.
5. Implement fallback chains: if primary provider fails, automatically retry with secondary provider.

## Consequences

**Positive:**
- Zero vendor-specific code in business logic, domain layers, or UI.
- Switching providers requires only configuration changes.
- Easy to add new providers without refactoring existing code.
- Fallback chains improve resilience against provider outages.

**Negative:**
- Additional abstraction layer at provider boundary increases code surface area.
- Some provider-specific optimizations may be missed due to normalization overhead.
- Transformation logic adds latency (minimal, typically <10ms per call).

## Implementation Notes

The `ProviderFactory` reads from environment configuration. Each `LLMProvider` subclass handles serialization, deserialization, and rate-limiting internally. Fallback chains are configured declaratively in the generation pipeline options.
