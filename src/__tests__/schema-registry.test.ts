import { describe, it, expect } from 'vitest';
import { ComponentRegistryImpl, SchemaRegistryError } from '../schema/registry.js';
import type { ComponentSchema } from '../types/index.js';

const sampleSchema: ComponentSchema = {
  type: 'Button',
  displayName: 'Button',
  props: {
    label: { type: 'string', required: true },
    variant: { type: 'enum', enum: ['primary', 'secondary'] },
    disabled: { type: 'boolean' },
  },
};

const cardSchema: ComponentSchema = {
  type: 'Card',
  displayName: 'Card',
  category: 'content',
  tags: ['card', 'content'],
  props: {
    title: { type: 'string', required: true },
    body: { type: 'richtext' },
  },
  slots: {
    footer: {
      displayName: 'Card Footer',
      allowedTypes: ['Button'],
      maxChildren: 3,
    },
  },
};

describe('ComponentRegistryImpl', () => {
  it('should register and retrieve a component schema', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(sampleSchema);

    const result = registry.get('Button');
    expect(result).toBeDefined();
    expect(result?.displayName).toBe('Button');
    expect(result?.props.label.required).toBe(true);
  });

  it('should reject duplicate registrations', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(sampleSchema);

    expect(() => registry.register(sampleSchema)).toThrow(SchemaRegistryError);
  });

  it('should reject invalid schemas', () => {
    const registry = new ComponentRegistryImpl();
    const invalid = { type: '', displayName: '', props: {} };

    expect(() => registry.register(invalid as ComponentSchema)).toThrow();
  });

  it('should list components with filters', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(sampleSchema);
    registry.register(cardSchema);

    // All components
    expect(registry.list().length).toBe(2);

    // Filter by category
    expect(registry.list({ category: 'content' }).length).toBe(1);

    // Filter by tags
    expect(registry.list({ tags: ['card'] }).length).toBe(1);
  });

  it('should exclude system components', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(sampleSchema);
    registry.register({
      type: 'box',
      displayName: 'Box',
      props: {},
    });

    const filtered = registry.list({ excludeSystem: true });
    expect(filtered.length).toBe(1);
    expect(filtered[0].type).toBe('Button');
  });

  it('should produce compact schema context', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(sampleSchema);
    registry.setDesignTokens({ colors: { primary: '#2563eb' } });
    registry.setConstraints({ maxDepth: 5, stylePolicy: 'tailwind' });

    const context = registry.toContext();

    expect(context.components.length).toBe(1);
    expect(context.components[0].type).toBe('Button');
    expect(context.components[0].props.label).toContain('string');
    expect(context.components[0].props.label).toContain('required');
    expect(context.designTokens?.colors?.primary).toBe('#2563eb');
    expect(context.constraints?.maxDepth).toBe(5);
  });

  it('should validate a correct tree', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(cardSchema);
    registry.register(sampleSchema);

    const tree = {
      type: 'Card',
      props: { title: 'Hello' },
      slots: {
        footer: [{ type: 'Button', props: { label: 'Click me' } }],
      },
    };

    const result = registry.validateTree(tree);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should detect unknown component types in tree', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(sampleSchema);

    const tree = { type: 'NonExistent', props: {} };
    const result = registry.validateTree(tree);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Unknown component type'))).toBe(true);
  });

  it('should detect missing required props', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(sampleSchema);

    const tree = { type: 'Button', props: { variant: 'primary' } };
    const result = registry.validateTree(tree);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Missing required prop'))).toBe(true);
  });

  it('should detect invalid slot children', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(cardSchema);
    registry.register(sampleSchema);
    registry.register({
      type: 'Image',
      displayName: 'Image',
      props: { src: { type: 'string', required: true } },
    });

    const tree = {
      type: 'Card',
      props: { title: 'Test' },
      slots: {
        footer: [{ type: 'Image', props: { src: 'test.png' } }],
      },
    };

    const result = registry.validateTree(tree);
    expect(result.errors.some((e) => e.includes('not allowed in slot'))).toBe(true);
  });

  it('should detect slot max children exceeded', () => {
    const registry = new ComponentRegistryImpl();
    registry.register(cardSchema);
    registry.register(sampleSchema);

    const tree = {
      type: 'Card',
      props: { title: 'Test' },
      slots: {
        footer: [
          { type: 'Button', props: { label: '1' } },
          { type: 'Button', props: { label: '2' } },
          { type: 'Button', props: { label: '3' } },
          { type: 'Button', props: { label: '4' } }, // exceeds max of 3
        ],
      },
    };

    const result = registry.validateTree(tree);
    expect(result.errors.some((e) => e.includes('maximum'))).toBe(true);
  });
});
