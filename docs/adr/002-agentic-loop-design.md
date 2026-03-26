# 002: Agentic Loop with Tool Calling

## Context

Single-shot LLM calls are insufficient for complex generation tasks where:
- The AI needs to inspect current application state before deciding what to generate.
- Component generation requires querying existing schema registries or databases.
- Intermediate results must be validated before proceeding.
- Multi-step reasoning is required (e.g., "first fetch the schema, then validate the props").

Without agentic capabilities, generation quality degrades and users receive incomplete or structurally invalid output.

## Decision

Implement an **agentic loop** where:

1. The AI generates text and tool calls concurrently.
2. Tools execute (e.g., `QuerySchema`, `ValidateProps`, `CheckConstraints`).
3. Tool results are fed back to the AI as context.
4. The AI continues generating based on new information.
5. The loop is **bounded by max iterations** (default: 10) to prevent infinite loops.
6. Timeout per iteration is configurable (default: 30s).

The loop terminates when the AI returns `done()` signal or max iterations are reached.

## Consequences

**Positive:**
- Dramatically better output quality for complex tasks.
- AI can adapt generation based on real-time application state.
- Validation failures trigger corrective AI reasoning automatically.
- Inspection of intermediate results catches errors early.

**Negative:**
- Higher latency per request (typically 2-5x single-shot calls).
- More provider API calls increase costs (~2-3x).
- Complex debugging due to multi-turn interactions.
- Users must understand loop semantics when extending the system.

## Implementation Notes

Tool execution is parallelized when possible. Timeouts apply per-iteration, not per-tool. The loop maintains full context history for transparency and replay capability.
