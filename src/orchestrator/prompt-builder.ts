/**
 * Prompt Builder
 *
 * Pattern: Context-Aware Prompt Assembly
 *
 * Constructs system and user prompts by injecting schema context,
 * design tokens, constraints, and current state. This ensures the AI
 * model has complete understanding of the target system before
 * attempting generation.
 *
 * Key insight: The quality of AI output is directly proportional to the
 * quality of context provided. This module is responsible for assembling
 * that context in a structured, token-efficient format.
 */

import type {
  GenerationRequest,
  GenerationContext,
  SchemaContext,
  ComponentSchemaCompact,
  DesignTokens,
  NodeDto,
} from '../types/index.js';

// ─── System Prompt ──────────────────────────────────────────────────────────

export function buildSystemPrompt(context: GenerationContext): string {
  const sections: string[] = [];

  sections.push(ROLE_SECTION);
  sections.push(buildSchemaSection(context.schema));

  if (context.schema.designTokens) {
    sections.push(buildDesignTokensSection(context.schema.designTokens));
  }

  if (context.schema.constraints) {
    sections.push(buildConstraintsSection(context.schema.constraints));
  }

  sections.push(OUTPUT_FORMAT_SECTION);
  sections.push(SAFETY_SECTION);

  return sections.join('\n\n');
}

// ─── User Message ───────────────────────────────────────────────────────────

export function buildUserMessage(request: GenerationRequest): string {
  const parts: string[] = [];

  // Current state context
  if (request.context.currentTree) {
    parts.push(
      `## Current Composition\n\`\`\`json\n${serializeTree(request.context.currentTree)}\n\`\`\``
    );
  }

  if (request.context.selectedNode) {
    parts.push(`## Selected Node\nUID: ${request.context.selectedNode}`);
  }

  if (request.context.pageData) {
    parts.push(
      `## Available Page Data\n\`\`\`json\n${JSON.stringify(request.context.pageData, null, 2)}\n\`\`\``
    );
  }

  // Mode-specific instructions
  const mode = request.options?.mode ?? 'generate';
  parts.push(buildModeInstructions(mode));

  // The actual user prompt
  parts.push(`## Request\n${request.prompt}`);

  return parts.join('\n\n');
}

// ─── Prompt Sections ────────────────────────────────────────────────────────

const ROLE_SECTION = `# Role
You are a composable UI generation system. You produce structured JSON changes
to a component tree based on a component schema, design tokens, and user intent.

You MUST only use components defined in the schema below. You MUST NOT invent
component types, prop names, or slot names that are not in the schema.`;

function buildSchemaSection(schema: SchemaContext): string {
  const componentDocs = schema.components
    .map(formatComponent)
    .join('\n\n');

  return `# Available Components\n\n${componentDocs}`;
}

function formatComponent(comp: ComponentSchemaCompact): string {
  const propsDoc = Object.entries(comp.props)
    .map(([name, type]) => `  - ${name}: ${type}`)
    .join('\n');

  const slotsDoc = comp.slots?.length
    ? `  Slots: ${comp.slots.join(', ')}`
    : '';

  return [
    `## ${comp.displayName} (\`${comp.type}\`)`,
    `  Props:`,
    propsDoc,
    slotsDoc,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildDesignTokensSection(tokens: DesignTokens): string {
  const sections: string[] = ['# Design Tokens'];

  if (tokens.colors && Object.keys(tokens.colors).length > 0) {
    sections.push(
      `## Colors\n${Object.entries(tokens.colors)
        .map(([name, value]) => `  - ${name}: ${value}`)
        .join('\n')}`
    );
  }

  if (tokens.spacing && Object.keys(tokens.spacing).length > 0) {
    sections.push(
      `## Spacing\n${Object.entries(tokens.spacing)
        .map(([name, value]) => `  - ${name}: ${value}`)
        .join('\n')}`
    );
  }

  if (tokens.typography && Object.keys(tokens.typography).length > 0) {
    sections.push(
      `## Typography\n${Object.entries(tokens.typography)
        .map(
          ([name, t]) =>
            `  - ${name}: ${t.fontFamily} ${t.fontSize}/${t.lineHeight} (${t.fontWeight})`
        )
        .join('\n')}`
    );
  }

  return sections.join('\n\n');
}

function buildConstraintsSection(
  constraints: NonNullable<SchemaContext['constraints']>
): string {
  const rules: string[] = ['# Generation Constraints'];

  if (constraints.maxDepth) {
    rules.push(`- Maximum nesting depth: ${constraints.maxDepth}`);
  }
  if (constraints.maxChildren) {
    rules.push(`- Maximum children per slot: ${constraints.maxChildren}`);
  }
  if (constraints.allowedComponentTypes?.length) {
    rules.push(
      `- Allowed component types: ${constraints.allowedComponentTypes.join(', ')}`
    );
  }
  if (constraints.disallowedComponentTypes?.length) {
    rules.push(
      `- Disallowed component types: ${constraints.disallowedComponentTypes.join(', ')}`
    );
  }
  if (constraints.stylePolicy) {
    rules.push(`- Style approach: ${constraints.stylePolicy}`);
  }

  return rules.join('\n');
}

const OUTPUT_FORMAT_SECTION = `# Output Format

Respond with a JSON object containing:

\`\`\`json
{
  "changes": [
    {
      "operation": "add" | "modify" | "remove" | "move",
      "targetUid": "uid of the node to modify/remove (required for modify/remove)",
      "parentUid": "uid of the parent node (required for add)",
      "slotId": "slot to add into (required for add)",
      "index": 0,
      "node": { /* Full NodeDto for add operations */ },
      "props": { /* Prop changes for modify operations */ },
      "styles": { /* Style changes for modify operations */ }
    }
  ],
  "explanation": "Brief explanation of what you did and why",
  "confidence": 0.9
}
\`\`\`

Rules:
- Every node MUST have a unique \`uid\` (use format: "node_<type>_<random>")
- Only use component types from the schema
- Props must match the schema's prop definitions
- Slots must use defined slot names
- Changes are applied in order: REMOVE → MODIFY → ADD`;

const SAFETY_SECTION = `# Safety Rules

1. NEVER generate executable code (JavaScript, script tags, event handlers)
2. NEVER include external URLs, iframes, or embedded content
3. NEVER modify nodes outside the selected subtree (if a selection is provided)
4. If the request is ambiguous, ask for clarification via the explanation field
5. If the request would violate constraints, explain why in the explanation field
6. Set confidence < 0.5 if you're unsure about the interpretation`;

function buildModeInstructions(mode: string): string {
  switch (mode) {
    case 'generate':
      return `## Mode: Generate\nCreate new components from scratch based on the request.`;
    case 'modify':
      return `## Mode: Modify\nModify the existing composition tree. Preserve nodes not mentioned in the request.`;
    case 'refine':
      return `## Mode: Refine\nRefine the previous generation based on feedback. Make minimal, targeted changes.`;
    default:
      return `## Mode: ${mode}`;
  }
}

// ─── Serialization ──────────────────────────────────────────────────────────

function serializeTree(node: NodeDto, maxDepth = 5, depth = 0): string {
  if (depth >= maxDepth) {
    return JSON.stringify({ uid: node.uid, type: node.type, '...': 'truncated' });
  }

  const simplified: Record<string, unknown> = {
    uid: node.uid,
    type: node.type,
  };

  if (node.props && Object.keys(node.props).length > 0) {
    simplified.props = node.props;
  }

  if (node.styles && Object.keys(node.styles).length > 0) {
    simplified.styles = node.styles;
  }

  if (node.slots) {
    const slots: Record<string, unknown[]> = {};
    for (const [slotId, children] of Object.entries(node.slots)) {
      slots[slotId] = children.map((child) =>
        JSON.parse(serializeTree(child, maxDepth, depth + 1))
      );
    }
    simplified.slots = slots;
  }

  return JSON.stringify(simplified, null, depth === 0 ? 2 : undefined);
}
