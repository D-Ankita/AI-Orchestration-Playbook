# 004: Zod-Validated Tool Calling

## Context

AI tool calls are fundamentally untrusted. The AI may:
- Pass invalid argument types or malformed JSON.
- Call non-existent tools.
- Provide arguments that violate semantic constraints.

Tool implementations may:
- Return malformed responses.
- Violate their declared output schema.
- Throw unexpected errors.

Both input and output violations can cascade through the system, corrupting state or generating invalid output.

## Decision

Use **Zod schemas for bidirectional validation**:

1. Each tool defines input schema as a Zod `z.object()`.
2. Each tool defines output schema as a Zod `z.object()`.
3. AI-generated tool calls are **parsed and validated against input schema** before execution.
4. Tool results are **parsed and validated against output schema** after execution.
5. Invalid input triggers immediate error with clear error message; AI can re-attempt.
6. Invalid output triggers logged warning and safe fallback value.
7. Tools support timeouts, retries with exponential backoff, and abort signals.

## Consequences

**Positive:**
- Strong compile-time and runtime type safety.
- Clear contracts prevent silent failures.
- Detailed error messages guide AI re-attempts.
- Timeout/abort support prevents resource exhaustion.

**Negative:**
- More boilerplate per tool definition (2-3 Zod schemas).
- Parsing overhead is measurable but acceptable (~5ms per tool call).
- Developers must define both input and output schemas accurately.
- Schema changes require careful versioning.

## Implementation Notes

Tools are registered via `ToolRegistry.register()` with input/output schemas. Validation errors are logged with full context for debugging. Retry logic is configurable per-tool or globally.
