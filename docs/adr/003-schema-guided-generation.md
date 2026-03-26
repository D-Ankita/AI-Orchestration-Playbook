# 003: Schema-Guided Generation

## Context

Unconstrained LLMs hallucinate component structures, invent non-existent prop names, use invalid type combinations, and generate TypeScript that doesn't compile. For example, an LLM might create a `<Button color="super-red" />` when only `color="red" | "blue" | "green"` are valid.

Users cannot manually verify every generated component. Generation errors propagate through build systems and break applications at runtime.

## Decision

Adopt **schema-guided generation**:

1. All component libraries must explicitly register their schemas via `ComponentRegistry.register()`.
2. Schemas are converted to a compact AI-readable format (JSON Schema with descriptions).
3. Schemas are injected into every LLM prompt as system context.
4. **All generated output is validated against registered schemas** before returning to the user.
5. Invalid output triggers AI re-generation with error context (e.g., "invalid prop type; allowed values are: red, blue, green").

## Consequences

**Positive:**
- Eliminates entire classes of generation errors.
- Generated code is guaranteed to match library contracts.
- Compile-time TypeScript correctness is automated.
- Self-correcting: the AI learns valid patterns from schema context.

**Negative:**
- Requires upfront schema definition for every component.
- Schema registration overhead (~50ms per app startup).
- LLM context window consumption increases (typically 5-10%).
- Schemas must stay in sync with actual component implementations.

## Implementation Notes

Schemas are cached after first registration. The validation layer reports structured error messages that guide re-generation. Schema versioning is supported to handle component library evolution.
