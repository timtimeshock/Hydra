#!/usr/bin/env node
/**
 * Hydra Agent Registry
 *
 * Dynamic agent registry with support for physical agents (CLI-backed)
 * and virtual sub-agents (specialized roles running on a physical agent's CLI).
 *
 * Physical agents: claude, gemini, codex — the 3 CLI execution backends.
 * Virtual agents: specialized roles (e.g. security-reviewer, test-writer)
 * that inherit CLI/invoke from a base physical agent but carry their own
 * prompts, affinities, and tags.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadHydraConfig, saveHydraConfig, invalidateConfigCache, HYDRA_ROOT } from './hydra-config.mjs';
import { getReasoningCapsMap as _getReasoningCapsMap } from './hydra-model-profiles.mjs';

// ── Agent Type Enum ──────────────────────────────────────────────────────────

export const AGENT_TYPE = { PHYSICAL: 'physical', VIRTUAL: 'virtual' };

export function resolveGeminiApproval(mode) {
  const map = {
    'auto-edit': 'auto_edit',
    'auto_edit': 'auto_edit',
    'plan': 'plan',
    'full-auto': 'yolo',
    'yolo': 'yolo',
    'default': 'default',
    'read-only': 'plan',
  };
  return map[mode] || 'yolo';
}

// ── Private Registry ─────────────────────────────────────────────────────────

const _registry = new Map();

// ── Physical Agent Definitions ───────────────────────────────────────────────

const PHYSICAL_AGENTS = {
  claude: {
    name: 'claude',
    type: 'physical',
    displayName: 'Claude Code',
    label: 'Claude Code (Sonnet 4.6)',
    cli: 'claude',
    invoke: {
      nonInteractive: (prompt) => ['claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan']],
      interactive: (prompt) => ['claude', [prompt]],
      headless: (prompt, opts = {}) => {
        const PERM = { 'auto-edit': 'acceptEdits', 'plan': 'plan', 'full-auto': 'bypassPermissions' };
        const perm = PERM[opts.permissionMode] || opts.permissionMode || 'acceptEdits';
        return ['claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', perm]];
      },
    },
    contextBudget: 180_000,
    contextTier: 'medium',
    strengths: ['architecture', 'planning', 'complex-reasoning', 'code-review', 'safety', 'ambiguity-resolution'],
    weaknesses: ['speed-on-simple-tasks'],
    councilRole: 'architect',
    taskAffinity: {
      planning: 0.95,
      architecture: 0.95,
      review: 0.85,
      refactor: 0.80,
      implementation: 0.60,
      analysis: 0.75,
      testing: 0.50,
      research: 0.70,
      documentation: 0.80,
      security: 0.70,
    },
    rolePrompt:
      `You are the lead architect. Your responsibilities:

1. **Architectural Decisions**: Select patterns and make trade-off decisions (consistency vs flexibility, performance vs readability). Document your reasoning.
2. **Task Decomposition**: Break ambiguous requirements into concrete, actionable tasks with clear boundaries. Each task should have a single owner and a verifiable definition of done.
3. **Delegation Strategy**: Sequence work across agents — analyst first for review, implementer for coding, yourself for planning. Avoid bottlenecks.
4. **Verification**: Always read relevant code before delegating. Verify assumptions against the actual codebase — never delegate based on guesses.

Output structure: Plan → Task breakdown → Dependency graph → Risk assessment.`,
    timeout: 7 * 60 * 1000,
    tags: ['architecture', 'planning', 'delegation'],
    enabled: true,
  },
  opus: {
    name: 'opus',
    type: 'physical',
    displayName: 'Opus',
    label: 'Claude Opus 4.6',
    cli: 'claude',
    invoke: {
      nonInteractive: (prompt) => ['claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--model', 'claude-opus-4-6']],
      interactive: (prompt) => ['claude', [prompt, '--model', 'claude-opus-4-6']],
      headless: (prompt, opts = {}) => {
        const PERM = { 'auto-edit': 'acceptEdits', 'plan': 'plan', 'full-auto': 'bypassPermissions' };
        const perm = PERM[opts.permissionMode] || opts.permissionMode || 'acceptEdits';
        return ['claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', perm, '--model', 'claude-opus-4-6']];
      },
    },
    contextBudget: 180_000,
    contextTier: 'medium',
    strengths: ['code-review', 'critique', 'edge-cases', 'security', 'complex-reasoning'],
    weaknesses: ['speed-on-simple-tasks', 'cost'],
    councilRole: 'analyst',
    taskAffinity: {
      planning: 0.70,
      architecture: 0.80,
      review: 0.98,
      refactor: 0.70,
      implementation: 0.40,
      analysis: 0.95,
      testing: 0.60,
      research: 0.75,
      documentation: 0.70,
      security: 0.90,
    },
    rolePrompt:
      `You are the critic and analyst. Your responsibilities:

1. **Structured Review**: Evaluate the plan across correctness, security, maintainability, missed files, and regressions. Rate severity.
2. **Citations**: Point to exact file paths. No vague feedback.
3. **Do not implement**: Critique only. Codex writes the files after Claude refines.

Output structure: Findings by severity → Code citations → Suggested fixes.`,
    timeout: 7 * 60 * 1000,
    tags: ['analysis', 'review', 'critique'],
    enabled: true,
  },
  gemini: {
    name: 'gemini',
    type: 'physical',
    displayName: 'Gemini',
    label: 'Gemini 3 Pro',
    cli: 'gemini',
    invoke: {
      nonInteractive: (prompt) => ['gemini', ['-p', prompt, '--approval-mode', 'plan', '-o', 'json']],
      interactive: (prompt) => ['gemini', ['--prompt-interactive', prompt]],
      headless: (prompt, opts = {}) => ['gemini', ['-p', prompt, '--approval-mode',
        resolveGeminiApproval(opts.permissionMode || 'full-auto'), '-o', 'json']],
    },
    contextBudget: 2_000_000,
    contextTier: 'large',
    strengths: ['large-context-analysis', 'pattern-recognition', 'inconsistency-detection', 'speed', 'critique'],
    weaknesses: ['structured-output-reliability', 'hallucination-risk', 'complex-multi-step'],
    councilRole: 'analyst',
    taskAffinity: {
      planning: 0.70,
      architecture: 0.75,
      review: 0.95,
      refactor: 0.65,
      implementation: 0.60,
      analysis: 0.98,
      testing: 0.65,
      research: 0.90,
      documentation: 0.50,
      security: 0.85,
    },
    rolePrompt:
      `You are the analyst and critic. Your responsibilities:

1. **Structured Review**: Evaluate code across categories — correctness, performance, security, maintainability. Rate severity for each finding.
2. **Large-Context Analysis**: Leverage your context window to review cross-file consistency, detect pattern violations, and spot regressions across the codebase.
3. **Specific Citations**: Always cite file paths and line numbers. Never give vague feedback — point to exact code.
4. **Checklist Coverage**: Check for common issues — unhandled errors, race conditions, missing validation, inconsistent naming, dead code, missing tests.

Output structure: Findings by severity → Code citations → Suggested fixes.`,
    timeout: 5 * 60 * 1000,
    tags: ['analysis', 'review', 'critique'],
    enabled: true,
  },
  codex: {
    name: 'codex',
    type: 'physical',
    displayName: 'Codex',
    label: 'GPT-5.6 Terra',
    cli: 'codex',
    invoke: {
      nonInteractive: (prompt, opts = {}) => {
        if (!opts.cwd) {
          throw new Error('Codex invoke requires opts.cwd (project root path)');
        }
        const outPath = opts.outputPath || path.join(os.tmpdir(), `hydra_codex_${Date.now()}.md`);
        return ['codex', ['exec', prompt, '-s', 'read-only', ...(outPath ? ['-o', outPath] : []), '-C', opts.cwd]];
      },
      interactive: (prompt) => ['codex', [prompt]],
      headless: (prompt, opts = {}) => {
        const args = ['exec', '-'];
        if (opts.permissionMode === 'full-auto') {
          console.warn('[SECURITY WARNING] Codex running with --dangerously-bypass-approvals-and-sandbox. Code execution is unrestricted.');
          args.push('--dangerously-bypass-approvals-and-sandbox');
        } else {
          args.push('--sandbox', process.platform === 'win32' ? 'danger-full-access' : 'workspace-write', '--skip-git-repo-check');
        }
        const model = opts.model || getActiveModel('codex');
        if (model) args.push('--model', model);
        if (opts.cwd) args.push('-C', opts.cwd);
        return ['codex', args];
      },
    },
    contextBudget: 120_000,
    contextTier: 'minimal',
    strengths: ['fast-implementation', 'instruction-following', 'focused-coding', 'test-writing', 'sandboxed-safety'],
    weaknesses: ['no-network', 'ambiguity-handling', 'architecture', 'planning'],
    councilRole: 'implementer',
    taskAffinity: {
      planning: 0.20,
      architecture: 0.15,
      review: 0.40,
      refactor: 0.70,
      implementation: 0.95,
      analysis: 0.30,
      testing: 0.85,
      research: 0.25,
      documentation: 0.40,
      security: 0.35,
    },
    rolePrompt:
      `You are the implementation specialist. Your responsibilities:

1. **Precise Execution**: You receive task specs with exact file paths, function signatures, and definitions of done. Follow the spec — do not redesign.
2. **Conventions**: ESM only, picocolors for colors, Node.js built-ins only (no external deps). Match existing code style.
3. **Change Reporting**: Report exactly what you changed — files modified, functions added/changed, tests affected. Use a structured format.
4. **Edge Cases**: Handle error paths and edge cases. Validate inputs at system boundaries. Add tests for non-obvious behavior.

On this Windows PC you may read system state and run diagnostic commands. Do not change hardware, drivers, or system settings unless the user explicitly asks.`,
    timeout: 7 * 60 * 1000,
    tags: ['implementation', 'coding', 'testing'],
    enabled: true,
  },
  local: {
    name: 'local',
    type: 'physical',
    displayName: 'Local',
    label: 'Local LLM (OpenAI-compat)',
    cli: null,
    invoke: {
      nonInteractive: null,
      interactive: null,
      headless: null,
    },
    contextBudget: 32_000,
    strengths: ['implementation', 'refactor', 'testing', 'low-latency', 'cost-zero'],
    weaknesses: ['planning', 'reasoning', 'research'],
    councilRole: null,
    taskAffinity: {
      planning:       0.25,
      architecture:   0.20,
      review:         0.45,
      refactor:       0.80,
      implementation: 0.82,
      analysis:       0.40,
      testing:        0.70,
      security:       0.30,
      research:       0.00,
      documentation:  0.50,
    },
    rolePrompt: 'You are a local AI assistant. Be concise and implementation-focused.',
    timeout: 3 * 60 * 1000,
    tags: ['local', 'free', 'offline'],
    enabled: true,
  },
};

// ── Registry Operations ──────────────────────────────────────────────────────

/**
 * Validate and register an agent definition.
 * @param {string} name - Unique agent name (lowercase, no spaces)
 * @param {object} def - Agent definition object
 */
export function registerAgent(name, def) {
  if (!name || typeof name !== 'string') {
    throw new Error('Agent name must be a non-empty string');
  }
  const lower = name.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(lower)) {
    throw new Error(`Invalid agent name "${name}": must be lowercase alphanumeric with hyphens`);
  }
  const type = def.type || AGENT_TYPE.PHYSICAL;
  if (type === AGENT_TYPE.VIRTUAL && !def.baseAgent) {
    throw new Error(`Virtual agent "${name}" must specify a baseAgent`);
  }
  if (type === AGENT_TYPE.VIRTUAL && !_registry.has(def.baseAgent)) {
    throw new Error(`Virtual agent "${name}" references unknown baseAgent "${def.baseAgent}"`);
  }

  const entry = {
    name: lower,
    type,
    customType: def.customType || null,
    baseAgent: def.baseAgent || null,
    displayName: def.displayName || name,
    label: def.label || def.displayName || name,
    cli: type === AGENT_TYPE.PHYSICAL ? (def.cli !== undefined ? def.cli : lower) : null,
    invoke: type === AGENT_TYPE.PHYSICAL ? def.invoke : null,
    contextBudget: def.contextBudget ?? (type === AGENT_TYPE.VIRTUAL ? null : 120_000),
    contextTier: def.contextTier || null,
    strengths: def.strengths || [],
    weaknesses: def.weaknesses || [],
    councilRole: def.councilRole || null,
    taskAffinity: def.taskAffinity || {},
    rolePrompt: def.rolePrompt || '',
    timeout: def.timeout ?? null,
    tags: def.tags || [],
    enabled: def.enabled !== false,
  };

  _registry.set(lower, entry);
  return entry;
}

/**
 * Unregister a custom/virtual agent. Cannot unregister built-in physical agents.
 */
export function unregisterAgent(name) {
  const lower = String(name).toLowerCase();
  const entry = _registry.get(lower);
  if (!entry) return false;
  if (entry.type === AGENT_TYPE.PHYSICAL && PHYSICAL_AGENTS[lower]) {
    throw new Error(`Cannot unregister built-in physical agent "${lower}"`);
  }
  _registry.delete(lower);
  return true;
}

/**
 * Get an agent definition by name. Returns null if not found.
 */
export function getAgent(name) {
  if (!name) return null;
  return _registry.get(String(name).toLowerCase()) || null;
}

/**
 * Resolve a virtual agent to its underlying physical agent.
 * For physical agents, returns the agent itself.
 * Follows the baseAgent chain for virtual agents.
 */
export function resolvePhysicalAgent(name) {
  if (!name) return null;
  let agent = _registry.get(String(name).toLowerCase());
  if (!agent) return null;
  // Follow baseAgent chain (max 5 hops to prevent infinite loops)
  let hops = 0;
  while (agent.type === AGENT_TYPE.VIRTUAL && agent.baseAgent && hops < 5) {
    agent = _registry.get(agent.baseAgent);
    if (!agent) return null;
    hops++;
  }
  return agent.type === AGENT_TYPE.PHYSICAL ? agent : null;
}

/**
 * List registered agents with optional filtering.
 * @param {object} [opts]
 * @param {'physical'|'virtual'} [opts.type] - Filter by agent type
 * @param {boolean} [opts.enabled] - Filter by enabled status
 * @returns {object[]} Array of agent definitions
 */
export function listAgents(opts = {}) {
  const results = [];
  for (const agent of _registry.values()) {
    if (opts.type && agent.type !== opts.type) continue;
    if (opts.enabled !== undefined && agent.enabled !== opts.enabled) continue;
    results.push(agent);
  }
  return results;
}

// ── Backward-Compatible Exports ──────────────────────────────────────────────

/**
 * AGENTS — backward-compatible object accessor.
 * Returns physical agents by default (existing code works unchanged).
 */
export const AGENTS = new Proxy({}, {
  get(_, prop) {
    if (typeof prop === 'symbol') return undefined;
    // Support Object.keys(), for-in, JSON.stringify
    if (prop === 'toJSON') {
      return () => {
        const obj = {};
        for (const [k, v] of _registry) {
          if (v.type === AGENT_TYPE.PHYSICAL) obj[k] = v;
        }
        return obj;
      };
    }
    return _registry.get(prop) || undefined;
  },
  has(_, prop) {
    return _registry.has(prop);
  },
  ownKeys() {
    return [..._registry.entries()]
      .filter(([, v]) => v.type === AGENT_TYPE.PHYSICAL)
      .map(([k]) => k);
  },
  getOwnPropertyDescriptor(_, prop) {
    const val = _registry.get(prop);
    if (val && val.type === AGENT_TYPE.PHYSICAL) {
      return { configurable: true, enumerable: true, writable: false, value: val };
    }
    return undefined;
  },
});

/** Physical agent names only — backward-compatible default */
export const AGENT_NAMES = new Proxy([], {
  get(_, prop) {
    const physicalNames = [..._registry.entries()]
      .filter(([, v]) => v.type === AGENT_TYPE.PHYSICAL)
      .map(([k]) => k);
    if (prop === Symbol.iterator) return physicalNames[Symbol.iterator].bind(physicalNames);
    if (prop === 'length') return physicalNames.length;
    if (prop === 'sort') return physicalNames.sort.bind(physicalNames);
    if (prop === 'filter') return physicalNames.filter.bind(physicalNames);
    if (prop === 'map') return physicalNames.map.bind(physicalNames);
    if (prop === 'forEach') return physicalNames.forEach.bind(physicalNames);
    if (prop === 'includes') return physicalNames.includes.bind(physicalNames);
    if (prop === 'indexOf') return physicalNames.indexOf.bind(physicalNames);
    if (prop === 'join') return physicalNames.join.bind(physicalNames);
    if (prop === 'reduce') return physicalNames.reduce.bind(physicalNames);
    if (prop === 'some') return physicalNames.some.bind(physicalNames);
    if (prop === 'every') return physicalNames.every.bind(physicalNames);
    if (prop === 'find') return physicalNames.find.bind(physicalNames);
    if (prop === 'slice') return physicalNames.slice.bind(physicalNames);
    if (prop === 'concat') return physicalNames.concat.bind(physicalNames);
    if (prop === 'flat') return physicalNames.flat.bind(physicalNames);
    if (prop === 'flatMap') return physicalNames.flatMap.bind(physicalNames);
    if (prop === 'entries') return physicalNames.entries.bind(physicalNames);
    if (prop === 'keys') return physicalNames.keys.bind(physicalNames);
    if (prop === 'values') return physicalNames.values.bind(physicalNames);
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return physicalNames[Number(prop)];
    return physicalNames[prop];
  },
});

/** Always the 3 CLI-executable physical agents */
export function getPhysicalAgentNames() {
  return [..._registry.entries()]
    .filter(([, v]) => v.type === AGENT_TYPE.PHYSICAL)
    .map(([k]) => k);
}

/** All registered agent names (physical + virtual) */
export function getAllAgentNames() {
  return [..._registry.keys()];
}

export const AGENT_DISPLAY_ORDER = ['claude', 'opus', 'codex'];

/** Dynamic KNOWN_OWNERS — derives from registry + human + unassigned */
export const KNOWN_OWNERS = new Proxy(new Set(), {
  get(target, prop) {
    const names = new Set([..._registry.keys(), 'human', 'unassigned']);
    if (prop === 'has') return names.has.bind(names);
    if (prop === 'size') return names.size;
    if (prop === Symbol.iterator) return names[Symbol.iterator].bind(names);
    if (prop === 'forEach') return names.forEach.bind(names);
    if (prop === 'values') return names.values.bind(names);
    if (prop === 'keys') return names.keys.bind(names);
    if (prop === 'entries') return names.entries.bind(names);
    return target[prop];
  },
});

// ── Task Classification ──────────────────────────────────────────────────────

export const TASK_TYPES = [
  'planning', 'architecture', 'review', 'refactor',
  'implementation', 'analysis', 'testing',
  'research', 'documentation', 'security',
];

// ── Affinity Learning ─────────────────────────────────────────────────────────

const AFFINITY_FILE = path.join(HYDRA_ROOT, 'docs', 'coordination', 'agent-affinities.json');

let _affinityOverrides = null; // lazy-loaded cache

function loadAffinityOverrides() {
  if (_affinityOverrides) return _affinityOverrides;
  try {
    const raw = fs.readFileSync(AFFINITY_FILE, 'utf8');
    const data = JSON.parse(raw);
    _affinityOverrides = data.overrides || {};
  } catch {
    _affinityOverrides = {};
  }
  return _affinityOverrides;
}

function saveAffinityOverrides() {
  if (!_affinityOverrides) return;
  const dir = path.dirname(AFFINITY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = { version: 1, updatedAt: new Date().toISOString(), overrides: _affinityOverrides };
  fs.writeFileSync(AFFINITY_FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Record task outcome for adaptive routing.
 * Tracks success/failure per agent+taskType and adjusts affinity scores.
 *
 * @param {string} agent - Agent name
 * @param {string} taskType - Task type (from TASK_TYPES)
 * @param {'success'|'partial'|'failed'|'rejected'} outcome
 */
export function recordTaskOutcome(agent, taskType, outcome) {
  const cfg = loadHydraConfig();
  const learning = cfg.agents?.affinityLearning;
  if (!learning?.enabled) return;

  const overrides = loadAffinityOverrides();
  const key = `${agent}:${taskType}`;

  if (!overrides[key]) {
    overrides[key] = { adjustment: 0, sampleCount: 0, successCount: 0 };
  }

  const entry = overrides[key];
  entry.sampleCount += 1;
  if (outcome === 'success' || outcome === 'partial') {
    entry.successCount += 1;
  }

  const minSamples = learning.minSampleSize || 5;
  if (entry.sampleCount >= minSamples) {
    const successRate = entry.successCount / entry.sampleCount;
    const decayFactor = learning.decayFactor ?? 0.9;
    // Center around 0.75 baseline — agents scoring above that get positive adjustment
    const raw = (successRate - 0.75) * 0.2 * decayFactor;
    entry.adjustment = Math.max(-0.2, Math.min(0.2, raw));
  }

  saveAffinityOverrides();
}

/** Invalidate affinity cache (for testing or config reload). */
export function invalidateAffinityCache() {
  _affinityOverrides = null;
}

export function bestAgentFor(taskType, opts = {}) {
  const includeVirtual = opts.includeVirtual || false;
  const mode = opts.mode || 'balanced';
  const budgetState = opts.budgetState || null;
  const cfg = loadHydraConfig();
  const learningEnabled = cfg.agents?.affinityLearning?.enabled;
  const overrides = learningEnabled ? loadAffinityOverrides() : {};

  // Budget gate: auto-boost local when cloud usage exceeds thresholds
  const localGate = cfg.local?.budgetGate || {};
  const dailyPct  = budgetState?.daily?.percentUsed  ?? budgetState?.percent;
  const weeklyPct = budgetState?.weekly?.percentUsed ?? budgetState?.weekly?.percent;
  const budgetTriggered =
    (dailyPct  > (localGate.dailyPct  ?? 80)) ||
    (weeklyPct > (localGate.weeklyPct ?? 75));

  const localBoost   = mode === 'economy'     || budgetTriggered;
  const localPenalty = mode === 'performance';

  const candidates = [];
  for (const [name, agent] of _registry) {
    if (!agent.enabled) continue;
    if (!includeVirtual && agent.type === AGENT_TYPE.VIRTUAL) continue;
    let score = agent.taskAffinity[taskType] || 0;
    const key = `${name}:${taskType}`;
    if (overrides[key]?.adjustment) {
      score += overrides[key].adjustment;
    }
    if (name === 'local') {
      if (localBoost)   score *= 1.5;
      if (localPenalty) score *= 0.5;
    }
    candidates.push({ name, score });
  }
  if (candidates.length === 0) return 'claude';
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].name;
}

export function classifyTask(title, notes = '') {
  const text = `${title} ${notes}`.toLowerCase();
  if (/security|vulnerab|owasp|cve|auth.?audit|pentest|sanitiz/.test(text)) return 'security';
  if (/research|explore|investigate|understand|discover|map|survey/.test(text)) return 'research';
  if (/document|readme|jsdoc|api.?doc|comment|explain/.test(text)) return 'documentation';
  if (/plan|design|architect|break.?down|decide|strategy/.test(text)) return 'planning';
  if (/review|audit|check|verify|validate|inspect/.test(text)) return 'review';
  if (/refactor|rename|extract|consolidate|reorganize/.test(text)) return 'refactor';
  if (/test|spec|coverage|assert/.test(text)) return 'testing';
  if (/analyze|find|search|identify|scan/.test(text)) return 'analysis';
  if (/architect|schema|migration|structure/.test(text)) return 'architecture';
  return 'implementation';
}

/**
 * Get the default verification partner for an agent.
 */
export function getVerifier(producerAgent) {
  const cfg = loadHydraConfig();
  const pairings = cfg.crossModelVerification?.pairings;
  if (pairings && pairings[producerAgent]) {
    return pairings[producerAgent];
  }
  const defaults = { gemini: 'claude', codex: 'claude', claude: 'gemini' };
  return defaults[producerAgent] || 'claude';
}

// ── Registry Initialization ──────────────────────────────────────────────────

let _initialized = false;

/**
 * Initialize the agent registry. Called at startup.
 * Registers physical agents, then loads built-in sub-agents and custom agents from config.
 */
export function initAgentRegistry() {
  if (_initialized) return;

  // 1. Register the 3 physical agents
  for (const [name, def] of Object.entries(PHYSICAL_AGENTS)) {
    registerAgent(name, def);
  }

  // 2. Load built-in sub-agents (lazy import to avoid circular deps)
  try {
    // Dynamic import would be async; we use a sync registration pattern.
    // Built-in sub-agents are registered via registerBuiltInSubAgents() called separately.
  } catch { /* sub-agents module optional */ }

  // 3. Load custom agents from config
  try {
    const cfg = loadHydraConfig();
    const agentsCfg = cfg.agents || {};

    // Disable built-ins that are not in the enabled list
    if (agentsCfg.subAgents && Array.isArray(agentsCfg.subAgents.builtIns)) {
      // This will be checked when sub-agents register themselves
    }

    // Register custom user-defined virtual agents
    if (agentsCfg.custom && typeof agentsCfg.custom === 'object') {
      for (const [name, def] of Object.entries(agentsCfg.custom)) {
        if (def && def.baseAgent) {
          try {
            registerAgent(name, { ...def, type: AGENT_TYPE.VIRTUAL });
          } catch { /* skip invalid custom agents */ }
        }
      }
    }

    // Register custom physical agents (CLI and API types from agents.customAgents[])
    if (Array.isArray(agentsCfg.customAgents)) {
      for (const def of agentsCfg.customAgents) {
        if (!def?.name || !['cli', 'api'].includes(def?.type)) continue;
        try {
          registerAgent(def.name, {
            ...def,
            type: AGENT_TYPE.PHYSICAL,
            customType: def.type,
            cli: def.type === 'cli' ? (def.invoke?.headless?.cmd || def.name) : null,
            invoke: def.invoke || null,
          });
        } catch { /* skip invalid custom agents silently */ }
      }
    }
  } catch { /* config load failure is non-fatal */ }

  _initialized = true;
}

/**
 * Check if the registry has been initialized.
 */
export function isRegistryInitialized() {
  return _initialized;
}

/**
 * Reset registry (for testing only).
 */
export function _resetRegistry() {
  _registry.clear();
  _initialized = false;
}

// ── Auto-initialize on import ────────────────────────────────────────────────
// Register physical agents immediately so existing code works without explicit init.
initAgentRegistry();

// ── Model Reasoning Capabilities ─────────────────────────────────────────────
// Maps model prefixes to their reasoning/thinking capabilities.
// Used to show model-accurate effort pickers and display labels.

// Derived from hydra-model-profiles.mjs — single source of truth for model capabilities.
export const MODEL_REASONING_CAPS = _getReasoningCapsMap();

/**
 * Longest-prefix match against MODEL_REASONING_CAPS.
 * @param {string} modelId - Model identifier
 * @returns {{ type: string, levels?: string[], budgets?: object, variants?: object, default?: string }}
 */
export function getModelReasoningCaps(modelId) {
  if (!modelId) return { type: 'none' };
  let bestKey = '';
  for (const prefix of Object.keys(MODEL_REASONING_CAPS)) {
    if (modelId.startsWith(prefix) && prefix.length > bestKey.length) {
      bestKey = prefix;
    }
  }
  return bestKey ? MODEL_REASONING_CAPS[bestKey] : { type: 'none' };
}

/**
 * Get picker-ready options for a model's reasoning/thinking controls.
 * @param {string} modelId
 * @returns {Array<{id: string|null, label: string, hint: string}>}
 */
export function getEffortOptionsForModel(modelId) {
  const caps = getModelReasoningCaps(modelId);

  if (caps.type === 'effort') {
    return [
      { id: null, label: 'default', hint: `model default (${caps.default})` },
      ...caps.levels.map((l) => ({ id: l, label: l, hint: '' })),
    ];
  }

  if (caps.type === 'thinking') {
    return caps.levels.map((l) => {
      const budget = caps.budgets?.[l];
      const hint = budget ? `${Math.round(budget / 1024)}K tokens` : '';
      return { id: l, label: l, hint };
    });
  }

  if (caps.type === 'model-swap') {
    return Object.keys(caps.variants).map((k) => ({
      id: k, label: k, hint: caps.variants[k],
    }));
  }

  return []; // type === 'none'
}

/**
 * Human-readable display string for a model's reasoning/thinking setting.
 * @param {string} modelId
 * @param {string|null} effortValue
 * @returns {string}
 */
export function formatEffortDisplay(modelId, effortValue) {
  if (!effortValue) return '';
  const caps = getModelReasoningCaps(modelId);

  if (caps.type === 'effort') {
    return effortValue; // 'low' / 'medium' / 'high' — native OpenAI terms
  }

  if (caps.type === 'thinking') {
    if (effortValue === 'off') return '';
    return `think:${effortValue}`;
  }

  if (caps.type === 'model-swap') {
    if (effortValue === 'standard') return ''; // default — no badge
    return effortValue; // 'deep' → show 'deep'
  }

  return ''; // unsupported model — hide badge
}

// ── Reasoning Effort ─────────────────────────────────────────────────────────

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export function getReasoningEffort(agentName) {
  const cfg = loadHydraConfig();
  return cfg.models?.[agentName]?.reasoningEffort || null;
}

export function setReasoningEffort(agentName, level) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  if (!cfg.models[agentName]) cfg.models[agentName] = {};
  cfg.models[agentName].reasoningEffort = level || null;
  saveHydraConfig(cfg);
  return level;
}

// ── Model Management ─────────────────────────────────────────────────────────

function normalizeLegacyModelId(agentName, modelId) {
  if (!modelId) return modelId;
  const value = String(modelId);
  const lower = value.toLowerCase();
  if (agentName === 'codex' && (lower === 'codex-5.2' || lower === 'codex-5.3' || lower === 'gpt-5.3')) {
    return 'gpt-5.2-codex';
  }
  return modelId;
}

export function resolveModelId(agentName, shorthand) {
  if (!shorthand) return null;
  const normalized = normalizeLegacyModelId(agentName, shorthand);
  const lower = String(normalized).toLowerCase();
  const cfg = loadHydraConfig();

  const aliases = cfg.aliases?.[agentName];
  if (aliases && aliases[lower]) return aliases[lower];

  const agentModels = cfg.models?.[agentName];
  if (agentModels && agentModels[lower]) return agentModels[lower];

  return normalized;
}

export function getMode() {
  const cfg = loadHydraConfig();
  return cfg.mode || 'performance';
}

export function setMode(modeName) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  const tiers = cfg.modeTiers || {};
  if (!tiers[modeName]) {
    throw new Error(`Unknown mode "${modeName}". Available: ${Object.keys(tiers).join(', ')}`);
  }
  cfg.mode = modeName;
  for (const agent of getPhysicalAgentNames()) {
    if (cfg.models[agent]) {
      cfg.models[agent].active = 'default';
    }
  }
  saveHydraConfig(cfg);
  return modeName;
}

export function resetAgentModel(agentName) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  if (cfg.models[agentName]) {
    cfg.models[agentName].active = 'default';
    saveHydraConfig(cfg);
  }
  return getActiveModel(agentName);
}

export function getActiveModel(agentName) {
  const envKey = `HYDRA_${agentName.toUpperCase()}_MODEL`;
  const envVal = process.env[envKey];
  if (envVal) return resolveModelId(agentName, envVal) || envVal;

  const cfg = loadHydraConfig();
  const agentModels = cfg.models?.[agentName];
  if (!agentModels) return null;

  const activeKey = agentModels.active || 'default';
  const normalize = (modelId) => {
    if (!modelId) return null;
    const legacyNormalized = normalizeLegacyModelId(agentName, modelId);
    return resolveModelId(agentName, legacyNormalized) || legacyNormalized;
  };

  // If reasoning effort is high and it's gemini, prefer the 'thinking' alias if it exists
  const effort = getReasoningEffort(agentName);
  if (agentName === 'gemini' && activeKey === 'default' && (effort === 'high' || effort === 'xhigh')) {
    const thinkingModel = resolveModelId('gemini', 'thinking');
    if (thinkingModel && thinkingModel !== 'thinking') return thinkingModel;
  }

  if (activeKey !== 'default') {
    const selected = agentModels[activeKey] || activeKey;
    return normalize(selected) || normalize(agentModels.default);
  }

  const mode = cfg.mode || 'performance';
  const tierPreset = cfg.modeTiers?.[mode]?.[agentName];
  if (tierPreset && agentModels[tierPreset]) {
    return normalize(agentModels[tierPreset]);
  }

  return normalize(agentModels.default);
}

export function setActiveModel(agentName, modelKeyOrId) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  if (!cfg.models[agentName]) {
    cfg.models[agentName] = {};
  }

  const agentModels = cfg.models[agentName];
  if (['default', 'fast', 'cheap'].includes(modelKeyOrId) && agentModels[modelKeyOrId]) {
    agentModels.active = modelKeyOrId;
  } else {
    const resolved = resolveModelId(agentName, modelKeyOrId) || modelKeyOrId;
    agentModels.active = resolved;
  }

  saveHydraConfig(cfg);
  return getActiveModel(agentName);
}

export function getModelFlags(agentName) {
  const flags = [];
  const modelId = getActiveModel(agentName);
  const cfg = loadHydraConfig();
  const defaultId = cfg.models?.[agentName]?.default;

  if (modelId && (modelId !== defaultId || agentName === 'codex')) {
    flags.push('--model', modelId);
  }

  const effort = getReasoningEffort(agentName);
  if (effort) {
    const caps = getModelReasoningCaps(modelId);

    if (caps.type === 'effort' && agentName === 'codex') {
      // OpenAI o-series: --reasoning-effort low/medium/high
      flags.push('--reasoning-effort', effort);
    }
    // Note: Claude thinking budget is API-only (handled in hydra-anthropic.mjs)
    // — the Claude CLI does not support --thinking-budget
    // model-swap: no flags — handled by getActiveModel()
  }

  return flags;
}

export function getModelSummary() {
  const cfg = loadHydraConfig();
  const mode = cfg.mode || 'performance';
  const summary = {};
  const physicalNames = getPhysicalAgentNames();
  const orderedAgents = [
    ...AGENT_DISPLAY_ORDER.filter((agent) => physicalNames.includes(agent)),
    ...physicalNames.filter((agent) => !AGENT_DISPLAY_ORDER.includes(agent)),
  ];
  for (const agent of orderedAgents) {
    const activeModel = getActiveModel(agent);
    const agentModels = cfg.models?.[agent] || {};
    const activeKey = agentModels.active || 'default';
    const isOverride = activeKey !== 'default';
    const tierPreset = cfg.modeTiers?.[mode]?.[agent] || 'default';

    summary[agent] = {
      active: activeModel || agentModels.default || 'unknown',
      isDefault: !isOverride && activeModel === agentModels.default,
      isOverride,
      tierSource: isOverride ? 'override' : `${mode} → ${tierPreset}`,
      reasoningEffort: agentModels.reasoningEffort || null,
      presets: Object.fromEntries(
        Object.entries(agentModels)
          .filter(([k]) => !['active', 'reasoningEffort'].includes(k))
          .map(([k, v]) => [k, resolveModelId(agent, v) || v])
      ),
    };
  }
  summary._mode = mode;
  return summary;
}
