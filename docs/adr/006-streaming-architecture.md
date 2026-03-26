# 006: Streaming Architecture

## Context

Users expect real-time feedback during AI generation. Waiting for full completion creates poor perceived latency and poor UX. Rendering partial results as they stream improves responsiveness.

However, unstructured streaming creates parsing challenges. Tools may execute mid-stream. State changes must be sequenced correctly. Clients need clear signals for different event types.

## Decision

Use **NDJSON streaming with typed events**:

1. Server streams newline-delimited JSON objects.
2. Each event has a type: `text`, `thinking`, `tool_start`, `tool_result`, `change`, `done`, `error`.
3. Events are ordered and complete (never truncated mid-JSON).
4. Clients parse incrementally with standard JSON parsers.
5. Backpressure is managed: clients signal readiness before receiving next batch.
6. Errors during streaming include context: which event failed and why.

Event types:
- `text`: partial text generation
- `thinking`: AI reasoning (if exposed by provider)
- `tool_start`: tool execution begins
- `tool_result`: tool execution completed
- `change`: state/structure update
- `done`: generation completed
- `error`: recovery-blocking error

## Consequences

**Positive:**
- Dramatically better perceived latency and UX.
- Clients render results in real-time.
- Tool execution is visible to users.
- Standard protocols (NDJSON) work with any HTTP client.

**Negative:**
- More complex client-side state management.
- Backpressure handling is non-trivial.
- Debugging is harder (distributed across client/server).
- Network overhead slightly higher than single response.

## Implementation Notes

Streaming uses HTTP chunked transfer encoding. Event schemas are versioned. Backpressure is implemented via async generators with standard rate-limiting patterns.
