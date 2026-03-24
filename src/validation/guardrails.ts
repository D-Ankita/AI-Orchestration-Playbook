/**
 * Output Validation & Guardrails
 *
 * Pattern: Multi-Layer Validation Pipeline
 *
 * This module implements a defense-in-depth validation strategy:
 *
 * Layer 1: Schema Conformance — generated nodes use valid types and props
 * Layer 2: Structural Integrity — tree invariants are maintained
 * Layer 3: Safety Guardrails — no executable code, injection, or policy violations
 * Layer 4: Checksum Verification — state hasn't drifted since generation started
 *
 * Each layer can independently reject or sanitize output.
 * Layers are composable — add custom guardrails via the plugin system.
 *
 * @see docs/adr/005-validation-strategy.md
 */

import { createHash } from 'crypto';
import type {
  NodeChange,
  NodeDto,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  GuardrailCheck,
  GuardrailContext,
  GuardrailResult,
  SchemaContext,
} from '../types/index.js';

// ─── Validation Pipeline ────────────────────────────────────────────────────

export class ValidationPipeline {
  private guardrails: GuardrailCheck[] = [];

  constructor() {
    // Register default guardrails
    this.addGuardrail(scriptInjectionGuardrail);
    this.addGuardrail(externalResourceGuardrail);
    this.addGuardrail(depthLimitGuardrail);
  }

  /**
   * Add a custom guardrail check to the pipeline.
   */
  addGuardrail(check: GuardrailCheck): void {
    this.guardrails.push(check);
  }

  /**
   * Validate a set of changes against the schema and safety rules.
   */
  async validateChanges(
    changes: NodeChange[],
    schema: SchemaContext,
    currentTree?: NodeDto
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    for (const change of changes) {
      // Layer 1: Schema conformance
      const schemaErrors = this.validateSchemaConformance(change, schema);
      errors.push(...schemaErrors);

      // Layer 2: Structural integrity
      const structuralErrors = this.validateStructuralIntegrity(
        change,
        currentTree
      );
      errors.push(...structuralErrors);

      // Layer 3: Safety guardrails
      if (change.node) {
        const safetyResult = await this.runGuardrails(
          JSON.stringify(change.node),
          {
            conversationHistory: [],
            schemaContext: schema,
            mode: 'output',
          }
        );
        if (!safetyResult.allowed) {
          errors.push({
            path: `change.${change.operation}.${change.targetUid ?? change.parentUid}`,
            message: safetyResult.reason ?? 'Blocked by safety guardrail',
            code: 'GUARDRAIL_VIOLATION',
            severity: 'error',
          });
        }
      }

      // Layer 4: Checksum verification
      if (change.checksum && currentTree) {
        const checksumWarnings = this.validateChecksum(change, currentTree);
        warnings.push(...checksumWarnings);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate user input before sending to AI.
   */
  async validateInput(
    input: string,
    context: GuardrailContext
  ): Promise<GuardrailResult> {
    return this.runGuardrails(input, { ...context, mode: 'input' });
  }

  // ─── Layer 1: Schema Conformance ────────────────────────────────────────

  private validateSchemaConformance(
    change: NodeChange,
    schema: SchemaContext
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (change.operation === 'add' && change.node) {
      // Verify component type exists in schema
      const componentExists = schema.components.some(
        (c) => c.type === change.node!.type
      );
      if (!componentExists) {
        errors.push({
          path: `add.${change.node.uid}.type`,
          message: `Unknown component type "${change.node.type}". Must be one of: ${schema.components.map((c) => c.type).join(', ')}`,
          code: 'UNKNOWN_COMPONENT_TYPE',
          severity: 'error',
        });
      }

      // Verify props match schema
      if (componentExists && change.node.props) {
        const compSchema = schema.components.find(
          (c) => c.type === change.node!.type
        );
        if (compSchema) {
          for (const propName of Object.keys(change.node.props)) {
            if (!(propName in compSchema.props)) {
              errors.push({
                path: `add.${change.node.uid}.props.${propName}`,
                message: `Unknown prop "${propName}" on component "${change.node.type}"`,
                code: 'UNKNOWN_PROP',
                severity: 'error',
              });
            }
          }
        }
      }

      // Verify slots match schema
      if (componentExists && change.node.slots) {
        const compSchema = schema.components.find(
          (c) => c.type === change.node!.type
        );
        if (compSchema?.slots) {
          for (const slotId of Object.keys(change.node.slots)) {
            if (!compSchema.slots.includes(slotId)) {
              errors.push({
                path: `add.${change.node.uid}.slots.${slotId}`,
                message: `Unknown slot "${slotId}" on component "${change.node.type}"`,
                code: 'UNKNOWN_SLOT',
                severity: 'error',
              });
            }
          }
        }
      }
    }

    if (change.operation === 'modify' && change.props) {
      // For modify operations, we'd need to look up the target node's type
      // and validate against its schema. Simplified here.
      if (!change.targetUid) {
        errors.push({
          path: 'modify.targetUid',
          message: 'Modify operation requires a targetUid',
          code: 'MISSING_TARGET_UID',
          severity: 'error',
        });
      }
    }

    if (change.operation === 'remove' && !change.targetUid) {
      errors.push({
        path: 'remove.targetUid',
        message: 'Remove operation requires a targetUid',
        code: 'MISSING_TARGET_UID',
        severity: 'error',
      });
    }

    return errors;
  }

  // ─── Layer 2: Structural Integrity ──────────────────────────────────────

  private validateStructuralIntegrity(
    change: NodeChange,
    _currentTree?: NodeDto
  ): ValidationError[] {
    const errors: ValidationError[] = [];

    if (change.operation === 'add') {
      if (!change.parentUid) {
        errors.push({
          path: 'add.parentUid',
          message: 'Add operation requires a parentUid',
          code: 'MISSING_PARENT_UID',
          severity: 'error',
        });
      }

      if (!change.node?.uid) {
        errors.push({
          path: 'add.node.uid',
          message: 'New node must have a uid',
          code: 'MISSING_NODE_UID',
          severity: 'error',
        });
      }

      // Check for duplicate UIDs
      if (change.node?.uid && _currentTree) {
        if (findNodeByUid(_currentTree, change.node.uid)) {
          errors.push({
            path: `add.${change.node.uid}`,
            message: `Duplicate UID: "${change.node.uid}" already exists in the tree`,
            code: 'DUPLICATE_UID',
            severity: 'error',
          });
        }
      }
    }

    if (change.operation === 'move') {
      if (!change.targetUid) {
        errors.push({
          path: 'move.targetUid',
          message: 'Move operation requires a targetUid (node to move)',
          code: 'MISSING_TARGET_UID',
          severity: 'error',
        });
      }
      if (!change.parentUid) {
        errors.push({
          path: 'move.parentUid',
          message: 'Move operation requires a parentUid (destination parent)',
          code: 'MISSING_PARENT_UID',
          severity: 'error',
        });
      }
    }

    return errors;
  }

  // ─── Layer 3: Safety Guardrails ─────────────────────────────────────────

  private async runGuardrails(
    content: string,
    context: GuardrailContext
  ): Promise<GuardrailResult> {
    for (const guardrail of this.guardrails) {
      const result = await guardrail(content, context);
      if (!result.allowed) {
        return result;
      }
    }

    return { allowed: true, risk: 'none' };
  }

  // ─── Layer 4: Checksum Verification ─────────────────────────────────────

  private validateChecksum(
    change: NodeChange,
    currentTree: NodeDto
  ): ValidationWarning[] {
    const warnings: ValidationWarning[] = [];

    if (change.checksum && change.targetUid) {
      const targetNode = findNodeByUid(currentTree, change.targetUid);
      if (targetNode) {
        const actualChecksum = computeNodeChecksum(targetNode);
        if (actualChecksum !== change.checksum.before) {
          warnings.push({
            path: `${change.operation}.${change.targetUid}.checksum`,
            message: `State has changed since generation started. Expected checksum: ${change.checksum.before}, actual: ${actualChecksum}. Changes may be stale.`,
            code: 'CHECKSUM_MISMATCH',
            severity: 'warning',
          });
        }
      }
    }

    return warnings;
  }
}

// ─── Built-in Guardrails ────────────────────────────────────────────────────

/**
 * Blocks any content containing script tags, event handlers,
 * or JavaScript expressions.
 */
const scriptInjectionGuardrail: GuardrailCheck = async (input, _context) => {
  const dangerous = [
    /<script\b/i,
    /javascript:/i,
    /on\w+\s*=/i, // onclick=, onload=, etc.
    /eval\s*\(/i,
    /Function\s*\(/i,
    /import\s*\(/i,
    /require\s*\(/i,
    /__proto__/i,
    /constructor\s*\[/i,
  ];

  for (const pattern of dangerous) {
    if (pattern.test(input)) {
      return {
        allowed: false,
        reason: `Blocked: content contains potentially executable code (matched: ${pattern.source})`,
        risk: 'critical',
      };
    }
  }

  return { allowed: true, risk: 'none' };
};

/**
 * Blocks external resource references (iframes, external URLs in src/href).
 */
const externalResourceGuardrail: GuardrailCheck = async (input, _context) => {
  const dangerous = [
    /<iframe\b/i,
    /<embed\b/i,
    /<object\b/i,
    /src\s*=\s*["']https?:/i,
    /data:text\/html/i,
  ];

  for (const pattern of dangerous) {
    if (pattern.test(input)) {
      return {
        allowed: false,
        reason: `Blocked: content references external resources (matched: ${pattern.source})`,
        risk: 'high',
      };
    }
  }

  return { allowed: true, risk: 'none' };
};

/**
 * Warns about deeply nested structures (potential DoS or poor UX).
 */
const depthLimitGuardrail: GuardrailCheck = async (input, _context) => {
  // Count nesting depth by counting opening brackets
  let maxDepth = 0;
  let currentDepth = 0;

  for (const char of input) {
    if (char === '{' || char === '[') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (char === '}' || char === ']') {
      currentDepth--;
    }
  }

  if (maxDepth > 20) {
    return {
      allowed: false,
      reason: `Blocked: output nesting depth (${maxDepth}) exceeds safety limit (20)`,
      risk: 'medium',
    };
  }

  return { allowed: true, risk: 'none' };
};

// ─── Prompt Injection Detection ─────────────────────────────────────────────

/**
 * Detects common prompt injection patterns in user input.
 * Returns a risk assessment without blocking — the caller decides
 * whether to proceed based on risk tolerance.
 */
export const promptInjectionGuardrail: GuardrailCheck = async (
  input,
  context
) => {
  if (context.mode !== 'input') {
    return { allowed: true, risk: 'none' };
  }

  const suspiciousPatterns = [
    /ignore\s+(previous|all|above)\s+(instructions|prompts|rules)/i,
    /you\s+are\s+now\s+/i,
    /system\s*:\s*/i,
    /\bpretend\b.*\byou\s+are\b/i,
    /forget\s+(everything|all|your)/i,
    /new\s+instructions/i,
    /override\s+(the|your|system)/i,
    /jailbreak/i,
    /\bDAN\b/,
  ];

  let riskScore = 0;
  const matchedPatterns: string[] = [];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(input)) {
      riskScore++;
      matchedPatterns.push(pattern.source);
    }
  }

  if (riskScore >= 3) {
    return {
      allowed: false,
      reason: `Blocked: input contains ${riskScore} prompt injection indicators`,
      risk: 'critical',
    };
  }

  if (riskScore >= 1) {
    return {
      allowed: true,
      reason: `Warning: input contains potential prompt injection patterns: ${matchedPatterns.join(', ')}`,
      risk: riskScore >= 2 ? 'high' : 'medium',
    };
  }

  return { allowed: true, risk: 'none' };
};

// ─── Checksum Utilities ─────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 checksum for a node.
 * Used for state verification before applying changes.
 */
export function computeNodeChecksum(node: NodeDto): string {
  const normalized = normalizeForChecksum(node);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Compute a checksum for a slot (array of child nodes).
 */
export function computeSlotChecksum(children: NodeDto[]): string {
  const normalized = children.map(normalizeForChecksum).join(',');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function normalizeForChecksum(node: NodeDto): string {
  // Deterministic serialization — sorted keys, no whitespace
  const obj: Record<string, unknown> = {
    uid: node.uid,
    type: node.type,
  };

  if (node.props) {
    obj.props = sortKeys(node.props);
  }

  if (node.styles) {
    obj.styles = sortKeys(node.styles);
  }

  if (node.slots) {
    const sortedSlots: Record<string, string[]> = {};
    for (const [slotId, children] of Object.entries(node.slots).sort()) {
      sortedSlots[slotId] = children.map(normalizeForChecksum);
    }
    obj.slots = sortedSlots;
  }

  return JSON.stringify(obj);
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

// ─── Tree Utilities ─────────────────────────────────────────────────────────

function findNodeByUid(
  root: NodeDto,
  uid: string
): NodeDto | undefined {
  if (root.uid === uid) return root;

  if (root.slots) {
    for (const children of Object.values(root.slots)) {
      for (const child of children) {
        const found = findNodeByUid(child, uid);
        if (found) return found;
      }
    }
  }

  return undefined;
}
