/**
 * Component Schema Registry
 *
 * Pattern: Registry + Schema-Guided Context
 *
 * The registry is the central source of truth for what components
 * the AI can use during generation. It validates component schemas
 * at registration time and provides a compact, token-efficient
 * representation for inclusion in AI prompts.
 *
 * Why this matters: Without schema guidance, LLMs will hallucinate
 * component types, prop names, and slot structures. The registry
 * ensures the AI only generates valid compositions.
 *
 * @see docs/adr/003-schema-guided-generation.md
 */

import { z } from 'zod';
import type {
  ComponentSchema,
  ComponentFilter,
  SchemaContext,
  ComponentSchemaCompact,
  PropDefinition,
  DesignTokens,
  GenerationConstraints,
  ComponentRegistry as IComponentRegistry,
} from '../types/index.js';

// ─── Schema Validation ──────────────────────────────────────────────────────

const PropDefinitionSchema = z.object({
  type: z.enum([
    'string',
    'number',
    'boolean',
    'object',
    'array',
    'richtext',
    'image',
    'link',
    'color',
    'enum',
  ]),
  description: z.string().optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
});

const SlotDefinitionSchema = z.object({
  displayName: z.string(),
  description: z.string().optional(),
  allowedTypes: z.array(z.string()).optional(),
  minChildren: z.number().optional(),
  maxChildren: z.number().optional(),
});

const ComponentSchemaValidator = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  props: z.record(PropDefinitionSchema),
  slots: z.record(SlotDefinitionSchema).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// ─── System Component Types ─────────────────────────────────────────────────

const SYSTEM_COMPONENT_TYPES = new Set([
  'box',
  'text',
  'fragment',
  'root',
  'slot',
]);

// ─── Registry Implementation ────────────────────────────────────────────────

export class ComponentRegistryImpl implements IComponentRegistry {
  components: Map<string, ComponentSchema> = new Map();
  private designTokens?: DesignTokens;
  private constraints?: GenerationConstraints;

  /**
   * Register a component schema.
   * Validates the schema at registration time — fail fast, not at generation time.
   */
  register(schema: ComponentSchema): void {
    const result = ComponentSchemaValidator.safeParse(schema);
    if (!result.success) {
      throw new SchemaRegistryError(
        `Invalid component schema for "${schema.type}": ${result.error.message}`
      );
    }

    if (this.components.has(schema.type)) {
      throw new SchemaRegistryError(
        `Component type "${schema.type}" is already registered. Use update() to modify.`
      );
    }

    this.components.set(schema.type, schema);
  }

  /**
   * Register multiple component schemas at once.
   */
  registerAll(schemas: ComponentSchema[]): void {
    for (const schema of schemas) {
      this.register(schema);
    }
  }

  /**
   * Update an existing component schema.
   */
  update(schema: ComponentSchema): void {
    const result = ComponentSchemaValidator.safeParse(schema);
    if (!result.success) {
      throw new SchemaRegistryError(
        `Invalid component schema for "${schema.type}": ${result.error.message}`
      );
    }
    this.components.set(schema.type, schema);
  }

  /**
   * Get a component schema by type.
   */
  get(type: string): ComponentSchema | undefined {
    return this.components.get(type);
  }

  /**
   * List components with optional filtering.
   */
  list(filter?: ComponentFilter): ComponentSchema[] {
    let components = Array.from(this.components.values());

    if (filter?.excludeSystem) {
      components = components.filter(
        (c) => !SYSTEM_COMPONENT_TYPES.has(c.type)
      );
    }

    if (filter?.category) {
      components = components.filter((c) => c.category === filter.category);
    }

    if (filter?.tags?.length) {
      const filterTags = new Set(filter.tags);
      components = components.filter(
        (c) => c.tags?.some((t) => filterTags.has(t))
      );
    }

    return components;
  }

  /**
   * Set design tokens that will be included in the AI context.
   */
  setDesignTokens(tokens: DesignTokens): void {
    this.designTokens = tokens;
  }

  /**
   * Set generation constraints.
   */
  setConstraints(constraints: GenerationConstraints): void {
    this.constraints = constraints;
  }

  /**
   * Convert the registry to a compact context format for AI prompts.
   * This is a critical optimization: full schemas can be thousands of tokens,
   * but the AI only needs type names, prop types, and slot names.
   */
  toContext(): SchemaContext {
    const components = this.list({ excludeSystem: true }).map(
      toCompactSchema
    );

    return {
      components,
      designTokens: this.designTokens,
      constraints: this.constraints,
    };
  }

  /**
   * Validate that a node tree only uses registered components and valid props.
   */
  validateTree(node: {
    type: string;
    props?: Record<string, unknown>;
    slots?: Record<string, Array<{ type: string; props?: Record<string, unknown>; slots?: Record<string, unknown[]> }>>;
  }): TreeValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    this.validateNode(node, [], errors, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateNode(
    node: { type: string; props?: Record<string, unknown>; slots?: Record<string, Array<{ type: string; props?: Record<string, unknown>; slots?: Record<string, unknown[]> }>> },
    path: string[],
    errors: string[],
    warnings: string[]
  ): void {
    const currentPath = [...path, node.type].join(' → ');
    const schema = this.components.get(node.type);

    if (!schema && !SYSTEM_COMPONENT_TYPES.has(node.type)) {
      errors.push(`Unknown component type "${node.type}" at ${currentPath}`);
      return;
    }

    if (schema && node.props) {
      // Check for unknown props
      for (const propName of Object.keys(node.props)) {
        if (!schema.props[propName]) {
          warnings.push(
            `Unknown prop "${propName}" on ${node.type} at ${currentPath}`
          );
        }
      }

      // Check for required props
      for (const [propName, propDef] of Object.entries(schema.props)) {
        if (propDef.required && !(propName in node.props)) {
          errors.push(
            `Missing required prop "${propName}" on ${node.type} at ${currentPath}`
          );
        }
      }
    }

    // Validate slots
    if (node.slots && schema?.slots) {
      for (const [slotId, children] of Object.entries(node.slots)) {
        if (!schema.slots[slotId]) {
          errors.push(
            `Unknown slot "${slotId}" on ${node.type} at ${currentPath}`
          );
          continue;
        }

        const slotDef = schema.slots[slotId];

        // Validate allowed types in slot
        if (slotDef.allowedTypes && Array.isArray(children)) {
          for (const child of children) {
            if (
              typeof child === 'object' &&
              child !== null &&
              'type' in child &&
              !slotDef.allowedTypes.includes((child as { type: string }).type)
            ) {
              errors.push(
                `Component type "${(child as { type: string }).type}" not allowed in slot "${slotId}" at ${currentPath}`
              );
            }
          }
        }

        // Validate min/max children
        if (Array.isArray(children)) {
          if (
            slotDef.minChildren !== undefined &&
            children.length < slotDef.minChildren
          ) {
            warnings.push(
              `Slot "${slotId}" has ${children.length} children, minimum is ${slotDef.minChildren} at ${currentPath}`
            );
          }
          if (
            slotDef.maxChildren !== undefined &&
            children.length > slotDef.maxChildren
          ) {
            errors.push(
              `Slot "${slotId}" has ${children.length} children, maximum is ${slotDef.maxChildren} at ${currentPath}`
            );
          }
        }

        // Recurse into children
        if (Array.isArray(children)) {
          for (const child of children) {
            if (typeof child === 'object' && child !== null && 'type' in child) {
              this.validateNode(
                child as { type: string; props?: Record<string, unknown>; slots?: Record<string, Array<{ type: string; props?: Record<string, unknown>; slots?: Record<string, unknown[]> }>> },
                [...path, node.type, slotId],
                errors,
                warnings
              );
            }
          }
        }
      }
    }
  }
}

// ─── Compact Schema Conversion ──────────────────────────────────────────────

function toCompactSchema(schema: ComponentSchema): ComponentSchemaCompact {
  const props: Record<string, string> = {};

  for (const [name, def] of Object.entries(schema.props)) {
    props[name] = formatPropType(def);
  }

  return {
    type: schema.type,
    displayName: schema.displayName,
    props,
    slots: schema.slots ? Object.keys(schema.slots) : undefined,
  };
}

function formatPropType(def: PropDefinition): string {
  let type = def.type as string;

  if (def.enum?.length) {
    type = `enum(${def.enum.join(' | ')})`;
  }

  if (def.required) {
    type += ' (required)';
  }

  if (def.description) {
    type += ` — ${def.description}`;
  }

  return type;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TreeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class SchemaRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaRegistryError';
  }
}
