# 005: Multi-Layer Validation Strategy

## Context

No single validation layer catches all problems. Examples:
- Schema conformance doesn't catch injection attacks or malicious code.
- Safety guardrails don't catch structural schema violations.
- Type checking doesn't catch business logic errors (e.g., circular component references).
- Checksum verification doesn't catch semantic corruption.

Defense-in-depth is required because validation is critical to system safety.

## Decision

Implement **four-layer validation**:

**Layer 1: Schema Conformance**
- Validate generated output matches registered component schemas.
- Type, prop names, constraints, and structure.

**Layer 2: Structural Integrity**
- Check for circular references, missing dependencies, orphaned components.
- Validate component tree is acyclic and well-formed.

**Layer 3: Safety Guardrails**
- Scan for injection patterns, eval/exec calls, suspicious imports.
- Enforce CSP (Content Security Policy) compatibility.
- Block dangerous patterns (arbitrary fetch, localStorage access in untrusted context).

**Layer 4: Checksum Verification**
- Hash generated code and maintain checksums for reproducibility.
- Detect silent corruption during transmission or caching.

Each layer is independent and can fail without cascading.

## Consequences

**Positive:**
- Near-zero chance of invalid output reaching the application.
- Multiple validation strategies catch different error classes.
- Transparency: each layer provides detailed feedback on failures.
- Security posture is significantly improved.

**Negative:**
- Additional processing per request (typically 50-150ms total).
- More code to maintain across four independent systems.
- Performance overhead may be noticeable on large component trees.
- Requires careful coordination to avoid false positives.

## Implementation Notes

Validation results are reported with layer-specific error messages. Caching is applied at layer boundaries for performance. Validation can be selectively disabled in development via feature flags.
