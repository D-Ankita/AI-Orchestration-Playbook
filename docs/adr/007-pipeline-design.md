# 007: Pipeline Composition

## Context

The ai-orchestration-playbook system comprises multiple subsystems:
- Schema registry and validation
- Agentic orchestration and tool calling
- Multi-layer validation (safety, structural, checksums)
- Streaming event production
- Provider abstraction and fallback chains

These subsystems must work together seamlessly. Without clear composition, integration points become ad-hoc, making the system fragile and hard to extend.

## Decision

Introduce **GenerationPipeline** as the primary public API:

1. `GenerationPipeline` accepts generation requests and composes all subsystems.
2. Internally, it orchestrates: schema validation → agentic loop → output validation → streaming.
3. Plugin hooks allow users to inject custom validators, tools, or providers at defined extension points.
4. Configuration is declarative: users specify provider chain, validation layers, and tool registry.
5. The pipeline is stateful but thread-safe for concurrent requests.

Example usage:
```typescript
const pipeline = new GenerationPipeline({
  providers: ['openai', 'anthropic'],
  tools: [querySchemaTools, validatePropsTools],
  validators: ['schema', 'structural', 'safety'],
  maxIterations: 10,
  streaming: true
});

for await (const event of pipeline.generate(request)) {
  client.send(event);
}
```

## Consequences

**Positive:**
- Single, clean public API hides subsystem complexity.
- Declarative configuration is easy to understand and test.
- Plugin hooks enable extensibility without modifying core.
- Composition ensures all subsystems work together correctly.

**Negative:**
- Internal coupling between subsystems requires careful interface design.
- Debugging multi-layer interactions is complex.
- Plugin hook contracts must be precisely documented.
- Performance depends heavily on subsystem ordering.

## Implementation Notes

The pipeline is built with async/await and async generators. Subsystems communicate via well-defined event types. Plugin hooks use TypeScript generics for type-safe extension. Configuration is validated at pipeline construction time.
