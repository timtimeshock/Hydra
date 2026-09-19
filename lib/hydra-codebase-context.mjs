#!/usr/bin/env node
/**
 * Hydra Codebase Context — Deep codebase knowledge for the concierge.
 *
 * Provides:
 * - Codebase query detection (regex-based, identifies topic)
 * - Topic-specific context extraction from CLAUDE.md sections
 * - Permanent baseline context (architecture overview + module index)
 * - Knowledge base search integration (evolve KB)
 * - Config reference formatting
 */

import fs from 'fs';
import path from 'path';
import { HYDRA_ROOT, loadHydraConfig } from './hydra-config.mjs';

// ── Constants ───────────────────────────────────────────────────────────────

const CLAUDE_MD_PATH = path.join(HYDRA_ROOT, 'CLAUDE.md');
const LIB_DIR = path.join(HYDRA_ROOT, 'lib');
const EVOLVE_DIR = path.join(HYDRA_ROOT, 'docs', 'coordination', 'evolve');

// ── Codebase Context Cache ──────────────────────────────────────────────────

let _cache = null;

/**
 * Load and parse CLAUDE.md into structured sections + build module index.
 * Cached in memory — call once at operator startup.
 * @returns {object} Parsed context with sections and module index
 */
export function loadCodebaseContext() {
  if (_cache) return _cache;

  const sections = {};
  let claudeMd = '';
  try {
    claudeMd = fs.readFileSync(CLAUDE_MD_PATH, 'utf8');
  } catch {
    claudeMd = '';
  }

  // Parse CLAUDE.md into named sections
  if (claudeMd) {
    const sectionRegex = /^##\s+(.+)$/gm;
    const headings = [];
    let match;
    while ((match = sectionRegex.exec(claudeMd)) !== null) {
      headings.push({ title: match[1].trim(), index: match.index });
    }
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end = i + 1 < headings.length ? headings[i + 1].index : claudeMd.length;
      const key = normalizeKey(headings[i].title);
      sections[key] = claudeMd.slice(start, end).trim();
    }
  }

  // Build module index from lib/*.mjs
  const moduleIndex = buildModuleIndex();

  _cache = { sections, moduleIndex, loadedAt: Date.now() };
  return _cache;
}

/**
 * Get the cached codebase context, loading if needed.
 * @returns {object}
 */
export function getCodebaseContext() {
  return _cache || loadCodebaseContext();
}

/**
 * Force reload (e.g. after doc updates).
 */
export function reloadCodebaseContext() {
  _cache = null;
  return loadCodebaseContext();
}

// ── Section Key Normalization ───────────────────────────────────────────────

function normalizeKey(heading) {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// ── Module Index Builder ────────────────────────────────────────────────────

function buildModuleIndex() {
  const index = [];

  // Scan lib/*.mjs
  try {
    const files = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.mjs')).sort();
    for (const file of files) {
      const purpose = extractModulePurpose(path.join(LIB_DIR, file));
      index.push({ file: `lib/${file}`, purpose });
    }
  } catch { /* skip */ }

  // Scan lib/hydra-shared/*.mjs
  const sharedDir = path.join(LIB_DIR, 'hydra-shared');
  try {
    const files = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.mjs')).sort();
    for (const file of files) {
      const purpose = extractModulePurpose(path.join(sharedDir, file));
      index.push({ file: `lib/hydra-shared/${file}`, purpose });
    }
  } catch { /* skip */ }

  // Scan lib/daemon/*.mjs
  const daemonDir = path.join(LIB_DIR, 'daemon');
  try {
    const files = fs.readdirSync(daemonDir).filter((f) => f.endsWith('.mjs')).sort();
    for (const file of files) {
      const purpose = extractModulePurpose(path.join(daemonDir, file));
      index.push({ file: `lib/daemon/${file}`, purpose });
    }
  } catch { /* skip */ }

  return index;
}

/**
 * Extract the first doc comment or purpose line from a module.
 */
function extractModulePurpose(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Look for top-of-file JSDoc: /** ... */
    const jsdocMatch = content.match(/^#!.*\n\/\*\*\s*\n\s*\*\s*(.+?)(?:\n|\s*\*\/)/);
    if (jsdocMatch) return jsdocMatch[1].trim().replace(/\s*\*\s*$/, '');
    // Look for first line comment: // ...
    const commentMatch = content.match(/^#!.*\n\/\/\s*(.+)/);
    if (commentMatch) return commentMatch[1].trim();
    // Look for JSDoc without shebang
    const jsdocMatch2 = content.match(/^\/\*\*\s*\n\s*\*\s*(.+?)(?:\n|\s*\*\/)/);
    if (jsdocMatch2) return jsdocMatch2[1].trim().replace(/\s*\*\s*$/, '');
    return '';
  } catch {
    return '';
  }
}

// ── Codebase Query Detection ────────────────────────────────────────────────

const TOPIC_KEYWORDS = {
  dispatch:  ['dispatch', 'routing', 'route', 'classify', 'fast-path', 'fast path', 'triage', 'auto mode', 'smart mode'],
  council:   ['council', 'deliberat', 'propose', 'critique', 'refine', 'multi-round'],
  config:    ['config', 'configur', 'setting', 'option', 'hydra.config', 'mode tier', 'model tier'],
  workers:   ['worker', 'headless', 'background', 'auto-chain', 'permission mode'],
  agents:    ['agent', 'registry', 'sub-agent', 'virtual agent', 'physical agent', 'task affinity', 'classify task'],
  concierge: ['concierge', 'chat mode', 'fallback chain', 'provider', 'openai', 'anthropic', 'google api'],
  evolve:    ['evolve', 'self-improvement', 'nightly', 'knowledge base', 'suggestion', 'investigator'],
  daemon:    ['daemon', 'event source', 'task queue', 'http api', 'sse', 'sync.json', 'events.jsonl'],
  ui:        ['status bar', 'statusbar', 'ui', 'terminal', 'prompt choice', 'spinner'],
  modules:   ['module', 'architecture', 'structure', 'overview', 'codebase', 'file map'],
  github:    ['github', 'pull request', 'pr', 'gh cli'],
  metrics:   ['metric', 'token', 'usage', 'cost', 'billing', 'budget'],
};

const CODEBASE_QUERY_PATTERNS = [
  // How does X work?
  { pattern: /how (?:does|do) (.+?) work/i, extractor: 'topic_from_capture' },
  { pattern: /(?:explain|describe|tell me about) (?:the )?(.+?)(?:\s+system|\s+module|\s+flow)?$/i, extractor: 'topic_from_capture' },
  // What handles/module for X?
  { pattern: /what (?:module|file|function|code) (?:handles?|is responsible for|manages?) (.+)/i, extractor: 'topic_from_capture' },
  { pattern: /where is (.+?) (?:implemented|defined|handled|located)/i, extractor: 'topic_from_capture' },
  // Architecture / overview
  { pattern: /(?:show|give|explain) (?:me )?(?:the )?(?:architecture|overview|structure|module map|file map)/i, topic: 'modules' },
  { pattern: /what modules (?:exist|are there|do we have)/i, topic: 'modules' },
  // Config queries
  { pattern: /what (?:config(?:uration)?|setting|option)s?(?: (?:option|setting)s?)? (?:exist|are there|are available|do we have)(?: for (.+))?/i, extractor: 'config_focus' },
  { pattern: /how (?:do I|to|can I) config(?:ure)? (.+)/i, extractor: 'topic_from_capture' },
  // What is X?
  { pattern: /what(?:'s| is) (?:the )?(.+?)(?:\s+module|\s+system)?$/i, extractor: 'topic_from_capture' },
];

/**
 * Detect whether a user message is a codebase/architecture query.
 * @param {string} message
 * @returns {{ isCodebaseQuery: boolean, topic: string|null }}
 */
export function detectCodebaseQuery(message) {
  if (!message || typeof message !== 'string') {
    return { isCodebaseQuery: false, topic: null };
  }
  const trimmed = message.trim();

  // Skip very short or clearly non-query messages
  if (trimmed.length < 8) return { isCodebaseQuery: false, topic: null };

  for (const { pattern, extractor, topic: fixedTopic } of CODEBASE_QUERY_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;

    if (fixedTopic) {
      return { isCodebaseQuery: true, topic: fixedTopic };
    }

    if (extractor === 'topic_from_capture' && match[1]) {
      const topic = inferTopic(match[1]);
      if (topic) return { isCodebaseQuery: true, topic };
    }
    if (extractor === 'config_focus') {
      return { isCodebaseQuery: true, topic: 'config' };
    }
  }

  return { isCodebaseQuery: false, topic: null };
}

/**
 * Infer a topic category from a freeform text fragment.
 */
function inferTopic(text) {
  const lower = text.toLowerCase();
  let bestTopic = null;
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        const score = kw.length; // longer keyword = more specific match
        if (score > bestScore) {
          bestScore = score;
          bestTopic = topic;
        }
      }
    }
  }
  return bestTopic;
}

// ── Topic Context Retrieval ─────────────────────────────────────────────────

/** Map topic names to CLAUDE.md section keys and supplementary info. */
const TOPIC_SECTIONS = {
  dispatch:  { keys: ['dispatch-modes', 'task-routing'], supplementWith: 'functions' },
  council:   { keys: ['key-modules'], filter: 'council', supplementWith: 'functions' },
  config:    { keys: ['code-conventions'], supplementWith: 'config' },
  workers:   { keys: ['key-modules'], filter: 'worker', supplementWith: 'config' },
  agents:    { keys: ['key-modules', 'task-routing'], filter: 'agent', supplementWith: 'functions' },
  concierge: { keys: ['key-modules'], filter: 'concierge', supplementWith: 'functions' },
  evolve:    { keys: ['key-modules'], filter: 'evolve', supplementWith: 'config' },
  daemon:    { keys: ['key-modules', 'architecture'], filter: 'daemon', supplementWith: 'endpoints' },
  ui:        { keys: ['key-modules'], filter: 'ui|statusbar|prompt', supplementWith: null },
  modules:   { keys: ['key-modules', 'architecture', 'dispatch-modes', 'task-routing'], supplementWith: null },
  github:    { keys: ['key-modules'], filter: 'github', supplementWith: 'config' },
  metrics:   { keys: ['key-modules'], filter: 'metric|usage|budget', supplementWith: 'config' },
};

/**
 * Get focused context for a specific topic.
 * @param {string} topic
 * @returns {string} Formatted context block
 */
export function getTopicContext(topic) {
  const ctx = getCodebaseContext();
  const topicDef = TOPIC_SECTIONS[topic];
  if (!topicDef) return getGeneralContext();

  const lines = [`=== CODEBASE CONTEXT: ${topic} ===`, ''];

  // Pull relevant CLAUDE.md sections
  for (const key of topicDef.keys) {
    const section = ctx.sections[key];
    if (!section) continue;

    if (topicDef.filter) {
      // Filter to paragraphs mentioning the topic
      const filterRe = new RegExp(topicDef.filter, 'i');
      const filtered = section.split('\n').filter((line) => {
        return line.startsWith('#') || line.startsWith('-') && filterRe.test(line) || filterRe.test(line);
      });
      if (filtered.length > 0) {
        lines.push(...filtered);
        lines.push('');
      }
    } else {
      lines.push(section);
      lines.push('');
    }
  }

  // Supplement with additional info
  if (topicDef.supplementWith === 'config') {
    const configRef = getConfigReference(topic);
    if (configRef) {
      lines.push(configRef);
      lines.push('');
    }
  }

  if (topicDef.supplementWith === 'functions') {
    const funcRef = getFunctionReference(topic);
    if (funcRef) {
      lines.push(funcRef);
      lines.push('');
    }
  }

  if (topicDef.supplementWith === 'endpoints') {
    lines.push(getDaemonEndpointsReference());
    lines.push('');
  }

  // Add relevant modules from index
  const relevantModules = ctx.moduleIndex.filter((m) => {
    const lower = m.file.toLowerCase() + ' ' + m.purpose.toLowerCase();
    return new RegExp(topicDef.filter || topic, 'i').test(lower);
  });
  if (relevantModules.length > 0) {
    lines.push('Related modules:');
    for (const m of relevantModules.slice(0, 10)) {
      lines.push(`- ${m.file}${m.purpose ? ` - ${m.purpose}` : ''}`);
    }
  }

  if (topic === 'modules') {
    lines.push('');
    lines.push('Full module reference: docs/ARCHITECTURE.md');
  }

  lines.push('', '=== END CONTEXT ===');

  // Enforce budget
  let result = lines.join('\n');
  if (result.length > 5000) {
    result = result.slice(0, 4980) + '\n... (truncated)\n=== END CONTEXT ===';
  }
  return result;
}

/**
 * Get general architecture overview context.
 */
function getGeneralContext() {
  const ctx = getCodebaseContext();
  const lines = ['=== CODEBASE CONTEXT: general ===', ''];

  // Architecture + Core Flow
  if (ctx.sections['architecture']) {
    lines.push(ctx.sections['architecture'].slice(0, 2000));
  }

  // Dispatch Modes
  if (ctx.sections['dispatch-modes']) {
    lines.push('', ctx.sections['dispatch-modes']);
  }

  // Module index summary
  lines.push('', 'Module index:');
  for (const m of ctx.moduleIndex.slice(0, 25)) {
    lines.push(`- ${m.file}${m.purpose ? ` - ${m.purpose}` : ''}`);
  }

  lines.push('', '=== END CONTEXT ===');
  return lines.join('\n').slice(0, 5000);
}

// ── Supplementary Reference Builders ────────────────────────────────────────

/**
 * Format relevant config section as readable reference.
 * @param {string} topic
 * @returns {string|null}
 */
export function getConfigReference(topic) {
  let config;
  try {
    config = loadHydraConfig();
  } catch {
    return null;
  }

  const TOPIC_CONFIG_MAP = {
    config:    () => ({ models: config.models, modeTiers: config.modeTiers, concierge: config.concierge }),
    workers:   () => config.workers || { note: 'workers.permissionMode, workers.autoStart, workers.pollIntervalMs, workers.maxOutputBufferKB, workers.autoChain' },
    concierge: () => config.concierge,
    evolve:    () => config.evolve,
    github:    () => config.github,
    agents:    () => config.agents,
    metrics:   () => config.usage,
    dispatch:  () => ({ modeTiers: config.modeTiers }),
  };

  const getter = TOPIC_CONFIG_MAP[topic];
  if (!getter) return null;

  try {
    const data = getter();
    return `Config (${topic}):\n${JSON.stringify(data, null, 2).slice(0, 1500)}`;
  } catch {
    return null;
  }
}

/** Key functions reference by topic. */
function getFunctionReference(topic) {
  const REFS = {
    dispatch: `Key functions:
- classifyPrompt(text) -> { tier, taskType, suggestedAgent, confidence, reason } [hydra-utils.mjs]
- classifyTask(text) -> taskType [hydra-agents.mjs]
- bestAgentFor(type, opts) -> agent [hydra-agents.mjs]
- publishFastPathDelegation({ baseUrl, from, promptText, classification }) [hydra-operator.mjs]
- publishMiniRoundDelegation({ baseUrl, from, agents, promptText, report }) [hydra-operator.mjs]
- runAutoPrompt({ baseUrl, from, agents, promptText, ... }) [hydra-operator.mjs]
- runSmartPrompt({ ... }) -> wraps runAutoPrompt with tier override [hydra-operator.mjs]`,

    council: `Key functions:
- runCouncilPrompt() -> spawns council subprocess [hydra-operator.mjs]
- buildStepPrompt(step, userPrompt, transcript, round, totalRounds, spec) [hydra-council.mjs]
- callAgentAsync(agent, prompt, timeoutMs) -> { ok, stdout, stderr } [hydra-council.mjs]
- extractTasksFromOutput(entries) [hydra-council.mjs]
- synthesizeCouncilTranscript(prompt, transcript) [hydra-council.mjs]

Council flow: propose (claude) -> critique (gemini) -> refine (claude) -> implement (codex)
Convergence: explicit criteria (correctness, complexity, reversibility, user impact) + assumption challenges + final synthesis, not majority vote`,

    agents: `Key functions:
- registerAgent(name, config) / unregisterAgent(name) [hydra-agents.mjs]
- resolvePhysicalAgent(name) -> follows baseAgent chain [hydra-agents.mjs]
- getActiveModel(agent) -> resolved model ID [hydra-agents.mjs]
- initAgentRegistry() -> registers claude, gemini, codex [hydra-agents.mjs]
- AGENT_TYPE.PHYSICAL / AGENT_TYPE.VIRTUAL

10 task types: planning, architecture, review, refactor, implementation, analysis, testing, security, research, documentation`,

    concierge: `Key functions:
- initConcierge(cfg) / conciergeTurn(userMsg, opts) [hydra-concierge.mjs]
- buildSystemPrompt(context) [hydra-concierge.mjs]
- streamWithFallback(chain, messages, opts) [hydra-concierge-providers.mjs]
- detectAvailableProviders() / buildFallbackChain(config) [hydra-concierge-providers.mjs]
- streamCompletion(cfg) [hydra-openai.mjs]
- streamAnthropicCompletion(cfg) [hydra-anthropic.mjs]
- streamGoogleCompletion(cfg) [hydra-google.mjs]

Fallback chain: OpenAI -> Anthropic -> Google (configurable)`,
  };
  return REFS[topic] || null;
}

/** Daemon HTTP endpoints reference. */
function getDaemonEndpointsReference() {
  return `Daemon endpoints (port 4173):
READ:
  GET /health          - Daemon health + model status
  GET /state           - Full state (tasks, handoffs, decisions, blockers)
  GET /summary         - Aggregated summary (open tasks, blockers, latest handoff)
  GET /activity        - Rich activity snapshot for concierge
  GET /events          - Last N events (default 50)
  GET /events/replay   - Replay from seq, filter by category
  GET /events/stream   - SSE real-time event stream
  GET /next?agent=X    - Suggest next action for agent
  GET /prompt?agent=X  - Build agent-specific prompt
  GET /session/status  - Active session info

WRITE:
  POST /task/add       - Create task { title, owner, status, type, notes }
  POST /task/claim     - Claim task { agent, taskId }
  POST /task/update    - Update task { taskId, status, notes, verify }
  POST /task/result    - Report completion { taskId, agent, status, output }
  POST /handoff        - Create handoff { from, to, summary, nextStep, tasks }
  POST /handoff/ack    - Acknowledge handoff { handoffId, agent }
  POST /events/push    - Push concierge events { type, payload }`;
}

// ── Knowledge Base Search ───────────────────────────────────────────────────

/**
 * Search the evolve knowledge base for relevant findings.
 * @param {string} query
 * @param {number} [maxResults=5]
 * @returns {string} Formatted findings or empty string
 */
export function searchKnowledgeBase(query, maxResults = 5) {
  let kb;
  try {
    // Lazy-load to avoid circular dependencies
    const { loadKnowledgeBase, searchEntries } = loadKBModule();
    kb = loadKnowledgeBase(EVOLVE_DIR);
    if (!kb || !kb.entries || kb.entries.length === 0) return '';

    const results = searchEntries(kb, query);
    if (results.length === 0) return '';

    const lines = [`Knowledge base findings for "${query}":`];
    for (const entry of results.slice(0, maxResults)) {
      const status = entry.attempted ? (entry.outcome || 'attempted') : 'researched';
      lines.push(`- [${entry.area || 'general'}] ${entry.finding.slice(0, 120)} (${status})`);
      if (entry.learnings) {
        lines.push(`  Learnings: ${entry.learnings.slice(0, 100)}`);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

let _kbModule = null;
function loadKBModule() {
  if (_kbModule) return _kbModule;
  // Synchronous dynamic require — the module is pure Node.js
  try {
    // Use a lazy approach: read and evaluate at first call
    const modPath = path.join(LIB_DIR, 'hydra-evolve-knowledge.mjs');
    // Since we can't synchronously import ESM, we'll read the KB file directly
    _kbModule = {
      loadKnowledgeBase: (dir) => {
        const filePath = path.join(dir, 'KNOWLEDGE_BASE.json');
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          return JSON.parse(raw);
        } catch {
          return { entries: [] };
        }
      },
      searchEntries: (kb, query) => {
        if (!kb?.entries) return [];
        const q = query.toLowerCase();
        return kb.entries.filter((e) =>
          (e.finding || '').toLowerCase().includes(q) ||
          (e.area || '').toLowerCase().includes(q) ||
          (e.learnings || '').toLowerCase().includes(q) ||
          (e.tags || []).some((t) => t.toLowerCase().includes(q))
        );
      },
    };
    return _kbModule;
  } catch {
    return { loadKnowledgeBase: () => ({ entries: [] }), searchEntries: () => [] };
  }
}

// ── Baseline Context (always injected) ──────────────────────────────────────

/**
 * Build the permanent baseline context that's always injected into the
 * concierge system prompt. Provides architecture awareness for any query.
 * @returns {string}
 */
export function getBaselineContext() {
  const ctx = getCodebaseContext();

  const lines = [
    'Codebase expertise:',
    '- You have deep knowledge of the Hydra codebase architecture, modules, and patterns.',
    '- When asked about how something works, reference specific modules and functions by name.',
    '- When asked about configuration, reference the exact config keys and their defaults.',
    '- Be specific: name files, functions, and line-level concepts rather than vague descriptions.',
    '',
  ];

  // Core architecture (compact)
  lines.push('Architecture:');
  lines.push('Hydra orchestrates 3 AI agents (Claude, Gemini, Codex) via HTTP daemon (port 4173) with event-sourced state.');
  lines.push('Operator Console (REPL) -> Concierge (OpenAI/Anthropic/Google) or Daemon -> Agents');
  lines.push('5 dispatch modes: auto (classify+route), council (4-phase deliberation + structured synthesis), dispatch (pipeline), smart (tier-select), chat (concierge)');
  lines.push('10 task types x 3 physical + 5 virtual sub-agents with affinity scoring');
  lines.push('');

  // Module quick-reference (one-liners)
  lines.push('Key modules:');
  const keyModules = [
    'hydra-operator.mjs - Interactive command center, 5 modes, worker management',
    'orchestrator-daemon.mjs - HTTP daemon, event-sourced state, task/handoff lifecycle',
    'hydra-agents.mjs - Agent registry, task classification, model routing',
    'hydra-config.mjs - Central config (hydra.config.json), project detection, HYDRA_ROOT',
    'hydra-council.mjs - 4-phase deliberation: propose->critique->refine->implement with structured synthesis',
    'hydra-concierge.mjs - Multi-provider chat front-end, intent detection, [DISPATCH] escalation',
    'hydra-worker.mjs - Headless background agent execution (AgentWorker class)',
    'hydra-evolve.mjs - 7-phase autonomous self-improvement with budget tracking',
    'hydra-statusbar.mjs - 5-line persistent ANSI footer, SSE event streaming',
    'hydra-metrics.mjs - Call metrics, token tracking, session cost aggregation',
    'hydra-ui.mjs - Terminal rendering (picocolors), agent colors/icons, formatters',
    'hydra-activity.mjs - Activity digest for concierge (situational queries, narratives)',
    'hydra-github.mjs - GitHub integration via gh CLI (PRs, issues)',
    'hydra-shared/ - Shared pipeline infra: git-ops, guardrails, budget-tracker, agent-executor',
  ];
  for (const m of keyModules) {
    lines.push(`- ${m}`);
  }
  lines.push('');

  // Config sections
  lines.push('Config sections (hydra.config.json):');
  lines.push('models, aliases, modeTiers, usage, verification, concierge, selfAwareness, roles, recommendations, agents, evolve, github, workers');

  return lines.join('\n');
}
