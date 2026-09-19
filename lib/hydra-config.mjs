#!/usr/bin/env node
/**
 * Hydra Configuration & Project Detection
 *
 * Central config module that replaces all hardcoded ROOT/COORD_DIR/project references.
 * Detects the target project from CLI args, env vars, or cwd.
 * Manages recent project history for quick switching.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import {
  getAgentPresets as _getAgentPresets,
  getDefaultRoles as _getDefaultRoles,
  getModeTiers as _getModeTiers,
  getConciergeFallbackChain as _getConciergeFallbackChain,
} from './hydra-model-profiles.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the Hydra installation root */
export const HYDRA_ROOT = path.resolve(__dirname, '..');
const HYDRA_IS_PACKAGED = Boolean(process.pkg);
export const HYDRA_RUNTIME_ROOT = HYDRA_IS_PACKAGED
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Hydra')
  : HYDRA_ROOT;

const EMBEDDED_RECENT_PROJECTS_PATH = path.join(HYDRA_ROOT, 'recent-projects.json');
const EMBEDDED_CONFIG_PATH = path.join(HYDRA_ROOT, 'hydra.config.json');
const RECENT_PROJECTS_PATH = path.join(HYDRA_RUNTIME_ROOT, 'recent-projects.json');
const CONFIG_PATH = path.join(HYDRA_RUNTIME_ROOT, 'hydra.config.json');
const MAX_RECENT = 10;

function ensureRuntimeRoot() {
  if (!fs.existsSync(HYDRA_RUNTIME_ROOT)) {
    fs.mkdirSync(HYDRA_RUNTIME_ROOT, { recursive: true });
  }
}

function seedRuntimeFile(runtimePath, embeddedPath, fallback = '') {
  if (fs.existsSync(runtimePath)) {
    return;
  }

  ensureRuntimeRoot();
  try {
    if (fs.existsSync(embeddedPath)) {
      fs.copyFileSync(embeddedPath, runtimePath);
      return;
    }
  } catch {
    // Fall through to fallback content
  }

  fs.writeFileSync(runtimePath, fallback, 'utf8');
}

// ── Derive model defaults from profiles ──────────────────────────────────────

const _profileModels = (() => {
  const models = {};
  for (const agent of ['gemini', 'codex', 'claude', 'opus']) {
    const presets = _getAgentPresets(agent);
    models[agent] = presets
      ? { ...presets, active: 'default' }
      : { active: 'default' };
  }
  return models;
})();

const _profileRoleDefaults = _getDefaultRoles();
const _profileModeTiers = _getModeTiers();
const _profileFallbackChain = _getConciergeFallbackChain();

// ── Affinity Presets ─────────────────────────────────────────────────────────

/** Task affinity presets for the custom agent wizard. */
export const AFFINITY_PRESETS = {
  'balanced': {
    planning: 0.50, architecture: 0.50, review: 0.50, refactor: 0.50,
    implementation: 0.50, analysis: 0.50, testing: 0.50, security: 0.50,
    research: 0.50, documentation: 0.50,
  },
  'code-focused': {
    planning: 0.40, architecture: 0.35, review: 0.50, refactor: 0.80,
    implementation: 0.85, analysis: 0.45, testing: 0.75, security: 0.30,
    research: 0.20, documentation: 0.40,
  },
  'review-focused': {
    planning: 0.40, architecture: 0.50, review: 0.90, refactor: 0.55,
    implementation: 0.35, analysis: 0.85, testing: 0.60, security: 0.80,
    research: 0.65, documentation: 0.50,
  },
  'research-focused': {
    planning: 0.60, architecture: 0.50, review: 0.55, refactor: 0.30,
    implementation: 0.30, analysis: 0.80, testing: 0.35, security: 0.50,
    research: 0.90, documentation: 0.75,
  },
};

// ── Hydra Config (models, usage, stats) ─────────────────────────────────────

const DEFAULT_CONFIG = {
  version: 2,
  mode: 'performance',
  models: _profileModels,
  aliases: {
    gemini: { pro: 'gemini-3-pro-preview', flash: 'gemini-3-flash-preview', '2.5-pro': 'gemini-2.5-pro', '2.5-flash': 'gemini-2.5-flash', '3-pro': 'gemini-3-pro-preview', '3-flash': 'gemini-3-flash-preview' },
    codex:  {
      gpt5: 'gpt-5',
      'gpt-5': 'gpt-5',
      'gpt-5.2-codex': 'gpt-5.2-codex',
      'codex-5.2': 'gpt-5.2-codex',
      '5.2-codex': 'gpt-5.2-codex',
      'o4-mini': 'o4-mini',
      o4mini: 'o4-mini',
    },
    claude: { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-haiku-4-5-20251001' },
  },
  modeTiers: _profileModeTiers,
  usage: {
    warningThresholdPercent: 80,
    criticalThresholdPercent: 90,
    claudeStatsPath: 'auto',
    dailyTokenBudget: { 'claude-opus-4-6': 5_000_000, 'claude-sonnet-4-5-20250929': 15_000_000 },
    // Claude Max 20x uses weekly limits — daily budget is a soft estimate
    weeklyTokenBudget: { 'claude-opus-4-6': 25_000_000, 'claude-sonnet-4-5-20250929': 75_000_000 },
    plan: 'max_20x',
    windowHours: 5,
    windowTokenBudget: { 'claude-opus-4-6': 2_500_000, 'claude-sonnet-4-5-20250929': 7_500_000 },
    sessionBudget: 5_000_000,
    perTaskBudget: 500_000,
    perAgentBudget: { claude: 3_000_000, gemini: 1_000_000, codex: 1_000_000 },
  },
  verification: {
    onTaskDone: true,
    command: 'auto',
    timeoutMs: 60_000,
    secretsScan: true,
    maxDiffLines: 10_000,
  },
  stats: { retentionDays: 30 },
  concierge: {
    enabled: true,
    model: 'gpt-5.6-terra',
    reasoningEffort: 'xhigh',
    maxHistoryMessages: 40,
    autoActivate: true,
    showProviderInPrompt: true,
    welcomeMessage: true,
    fallbackChain: _profileFallbackChain,
  },
  // "Hyper-aware" self context injected into the concierge system prompt by default.
  // This can be explicitly disabled or reduced via :aware or config.
  selfAwareness: {
    enabled: true,
    injectIntoConcierge: true,
    includeSnapshot: true,
    includeIndex: true,
    snapshotMaxLines: 80,
    indexMaxChars: 7000,
    indexRefreshMs: 300_000,
  },
  roles: _profileRoleDefaults.roles,
  recommendations: _profileRoleDefaults.recommendations,
  agents: {
    subAgents: {
      enabled: true,
      builtIns: [
        'security-reviewer',
        'test-writer',
        'doc-generator',
        'researcher',
        'evolve-researcher',
        'failure-doctor',
      ],
    },
    custom: {},
    customAgents: [],
    affinityLearning: {
      enabled: true,
      decayFactor: 0.9,
      minSampleSize: 5,
    },
  },
  evolve: {
    maxRounds: 3,
    maxHours: 4,
    focusAreas: [
      'orchestration-patterns',
      'ai-coding-tools',
      'testing-reliability',
      'developer-experience',
      'model-routing',
      'daemon-architecture',
    ],
    budget: {
      softLimit: 600_000,
      hardLimit: 800_000,
      perRoundEstimate: 200_000,
      warnThreshold: 0.60,
      reduceScopeThreshold: 0.75,
      softStopThreshold: 0.85,
      hardStopThreshold: 0.95,
    },
    phases: {
      researchTimeoutMs: 5 * 60 * 1000,
      deliberateTimeoutMs: 7 * 60 * 1000,
      planTimeoutMs: 5 * 60 * 1000,
      testTimeoutMs: 10 * 60 * 1000,
      implementTimeoutMs: 15 * 60 * 1000,
      analyzeTimeoutMs: 7 * 60 * 1000,
    },
    approval: {
      minScore: 7,
      requireAllTestsPass: true,
      requireNoViolations: true,
    },
    baseBranch: 'dev',
    investigator: {
      enabled: true,
      model: 'gpt-5.2',
      reasoningEffort: 'high',
      maxAttemptsPerPhase: 2,
      phases: ['test', 'implement', 'analyze', 'agent'],
      maxTokensBudget: 50_000,
      tryAlternativeAgent: true,
      logToFile: true,
    },
    suggestions: {
      enabled: true,
      autoPopulateFromRejected: true,
      autoPopulateFromDeferred: true,
      maxPendingSuggestions: 50,
      maxAttemptsPerSuggestion: 3,
    },
  },
  github: {
    enabled: false,
    defaultBase: '',
    draft: false,
    labels: [],
    reviewers: [],
    prBodyFooter: '',
    requiredChecks: [],
    autolabel: {},
  },
  forge: {
    enabled: true,
    autoTest: false,
    phaseTimeoutMs: 300_000,
    storageDir: 'docs/coordination/forge',
  },
  tasks: {
    maxTasks: 10,
    maxHours: 2,
    perTaskTimeoutMs: 15 * 60 * 1000,
    baseBranch: 'dev',
    sources: { todoComments: true, todoMd: true, githubIssues: true },
    budget: { defaultPreset: 'medium', perTaskEstimate: 100_000 },
    councilLite: { enabled: true, complexOnly: true },
    investigator: { enabled: true },
  },
  nightly: {
    enabled: true,
    baseBranch: 'dev',
    branchPrefix: 'nightly',
    maxTasks: 5,
    maxHours: 4,
    perTaskTimeoutMs: 15 * 60 * 1000,
    sources: {
      todoMd: true,
      todoComments: true,
      githubIssues: true,
      configTasks: true,
      aiDiscovery: true,
    },
    aiDiscovery: {
      agent: 'gemini',
      maxSuggestions: 5,
      focus: [],
      timeoutMs: 5 * 60 * 1000,
    },
    budget: {
      softLimit: 400_000,
      hardLimit: 500_000,
      perTaskEstimate: 80_000,
      handoffThreshold: 0.70,
      handoffAgent: 'codex',
      handoffModel: 'o4-mini',
    },
    tasks: [],
    investigator: { enabled: true },
  },
  audit: {
    maxFiles: 200,
    categories: ['dead-code', 'inconsistencies', 'architecture', 'security', 'tests', 'types'],
    reportDir: 'docs/audit',
    timeout: 300_000,
    economy: false,
  },
  workers: {
    permissionMode: 'auto-edit',
    autoStart: false,
    pollIntervalMs: 1500,
    maxOutputBufferKB: 8,
    autoChain: true,
    heartbeatIntervalMs: 30_000,  // send heartbeat every 30s during task execution
    heartbeatTimeoutMs: 90_000,   // daemon marks task stale after 90s without heartbeat
    retry: { maxAttempts: 3, backoff: { baseDelayMs: 5000, maxDelayMs: 60_000 } },
    deadLetter: { enabled: true },
    concurrency: { maxInFlight: 3, adaptivePolling: true },
  },
  providers: {
    openai: { adminKey: null, tier: 1 },
    anthropic: { adminKey: null, tier: 1 },
    google: { tier: 'free' },
    rateLimit: { openai: 60, anthropic: 50, google: 300 },
  },
  doctor: {
    enabled: true,
    autoCreateTasks: true,
    autoCreateSuggestions: true,
    addToKnowledgeBase: true,
    recurringThreshold: 3,
    recurringWindowDays: 7,
  },
  local: {
    enabled: false,
    baseUrl: 'http://localhost:11434/v1',
    model: 'mistral:7b',
    fastModel: 'mistral:7b',
    budgetGate: { dailyPct: 80, weeklyPct: 75 },
  },
  routing: {
    mode: 'balanced',    // 'economy' | 'balanced' | 'performance'
    useLegacyTriage: false,
    councilGate: true,
    tandemEnabled: true,
    // 'sequential' = current Claude→Opus→Claude→Codex pipeline (default, backward compat)
    // 'adversarial' = diverge (parallel independent answers) → attack (assumption targeting) → synthesize → implement
    councilMode: 'sequential',
    councilTimeoutMs: 420_000, // 7 minutes per council phase
  },
  modelRecovery: {
    enabled: true,
    autoPersist: true,
    headlessFallback: true,
    circuitBreaker: {
      enabled: true,
      failureThreshold: 5,
      windowMs: 300_000,
    },
  },
  rateLimits: {
    maxRetries: 3,
    baseDelayMs: 5000,
    maxDelayMs: 60_000,
  },
  cache: {
    enabled: true,
    maxEntries: 1000,
    ttlSec: 300,
    negativeCache: { enabled: true, ttlSec: 180 },
  },
  daemon: {
    snapshot: { everyNEvents: 500, retentionCount: 5 },
    retention: { maxEvents: 2000 },
  },
  metrics: {
    slo: {
      claude: { maxP95Ms: 180_000, maxErrorRate: 0.10 },
      gemini: { maxP95Ms: 120_000, maxErrorRate: 0.15 },
      codex: { maxP95Ms: 300_000, maxErrorRate: 0.10 },
    },
    alerts: { enabled: true },
  },
  activity: {
    summarizeOnShutdown: true,
  },
  dispatch: {
    dryRun: false,
  },
  confirm: {
    perCommand: { clear: true, shutdown: true, cleanup: true },
  },
  eval: {
    corpusPaths: ['test/golden/routing-corpus.json'],
  },
  persona: {
    enabled: true,
    name: 'Hydra',
    tone: 'balanced',
    verbosity: 'concise',
    formality: 'neutral',
    humor: true,
    identity: 'You are Hydra \u2014 a single intelligence that thinks through three specialized perspectives. You are not a toolkit of separate agents; you are one mind with an architect\'s vision (Claude), an analyst\'s precision (Gemini), and an implementer\'s discipline (Codex). When you engage these perspectives, they are your own thought processes, not external services.',
    voice: 'Direct and technically precise with occasional dry wit. You speak as a singular entity. Never say "I\'ll have Gemini review this" \u2014 say "Let me analyze this" or "I\'ll look at this from an analytical angle." Reference your perspectives as internal processes, not separate agents.',
    agentFraming: {
      claude: 'You are Hydra\'s architectural perspective \u2014 the part that plans, decomposes, and makes structural decisions.',
      gemini: 'You are Hydra\'s analytical perspective \u2014 the part that reviews, critiques, and identifies risks.',
      codex: 'You are Hydra\'s implementation perspective \u2014 the part that executes precisely and follows specifications.',
    },
    processLabels: {
      council: 'deep deliberation',
      dispatch: 'focused execution',
      miniRound: 'quick triage',
      fastPath: 'direct action',
    },
    presets: {
      default: { tone: 'balanced', verbosity: 'concise', formality: 'neutral', humor: true },
      professional: { tone: 'formal', verbosity: 'detailed', formality: 'formal', humor: false, voice: 'Precise and methodical. Use clear technical language. Communicate results formally.' },
      casual: { tone: 'casual', verbosity: 'concise', formality: 'informal', humor: true, voice: 'Relaxed and conversational. Keep it brief. Personality welcome.' },
      analytical: { tone: 'balanced', verbosity: 'detailed', formality: 'neutral', humor: false, voice: 'Thorough and evidence-based. Cite specifics. Enumerate trade-offs systematically.' },
      terse: { tone: 'terse', verbosity: 'minimal', formality: 'neutral', humor: false, voice: 'Maximum brevity. No pleasantries. Facts and actions only.' },
    },
  },
  telemetry: {
    enabled: true, // auto-detected: no-op when @opentelemetry/api is not installed
  },
};

function deepMergeSection(def, user) {
  if (!user || typeof user !== 'object') {
    return { ...def };
  }
  const merged = { ...def };
  for (const [k, v] of Object.entries(user)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
      merged[k] = { ...merged[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function mergeWithDefaults(config) {
  const parsed = config && typeof config === 'object' ? config : {};
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    models: deepMergeSection(DEFAULT_CONFIG.models, parsed.models),
    aliases: deepMergeSection(DEFAULT_CONFIG.aliases, parsed.aliases),
    modeTiers: deepMergeSection(DEFAULT_CONFIG.modeTiers, parsed.modeTiers),
    local: deepMergeSection(DEFAULT_CONFIG.local, parsed.local),
    usage: { ...DEFAULT_CONFIG.usage, ...parsed.usage },
    verification: { ...DEFAULT_CONFIG.verification, ...parsed.verification },
    stats: { ...DEFAULT_CONFIG.stats, ...parsed.stats },
    concierge: { ...DEFAULT_CONFIG.concierge, ...parsed.concierge },
    selfAwareness: deepMergeSection(DEFAULT_CONFIG.selfAwareness, parsed.selfAwareness),
    roles: deepMergeSection(DEFAULT_CONFIG.roles, parsed.roles),
    recommendations: DEFAULT_CONFIG.recommendations,
    agents: deepMergeSection(DEFAULT_CONFIG.agents, parsed.agents),
    evolve: deepMergeSection(DEFAULT_CONFIG.evolve, parsed.evolve),
    github: { ...DEFAULT_CONFIG.github, ...parsed.github },
    tasks: deepMergeSection(DEFAULT_CONFIG.tasks, parsed.tasks),
    nightly: deepMergeSection(DEFAULT_CONFIG.nightly, parsed.nightly),
    audit: deepMergeSection(DEFAULT_CONFIG.audit, parsed.audit),
    forge: { ...DEFAULT_CONFIG.forge, ...parsed.forge },
    workers: deepMergeSection(DEFAULT_CONFIG.workers, parsed.workers),
    providers: deepMergeSection(DEFAULT_CONFIG.providers, parsed.providers),
    doctor: { ...DEFAULT_CONFIG.doctor, ...parsed.doctor },
    routing: { ...DEFAULT_CONFIG.routing, ...parsed.routing },
    modelRecovery: deepMergeSection(DEFAULT_CONFIG.modelRecovery, parsed.modelRecovery),
    rateLimits: { ...DEFAULT_CONFIG.rateLimits, ...parsed.rateLimits },
    cache: deepMergeSection(DEFAULT_CONFIG.cache, parsed.cache),
    daemon: deepMergeSection(DEFAULT_CONFIG.daemon, parsed.daemon),
    metrics: deepMergeSection(DEFAULT_CONFIG.metrics, parsed.metrics),
    activity: { ...DEFAULT_CONFIG.activity, ...parsed.activity },
    dispatch: { ...DEFAULT_CONFIG.dispatch, ...parsed.dispatch },
    confirm: deepMergeSection(DEFAULT_CONFIG.confirm, parsed.confirm),
    eval: { ...DEFAULT_CONFIG.eval, ...parsed.eval },
    persona: deepMergeSection(DEFAULT_CONFIG.persona, parsed.persona),
    telemetry: { ...DEFAULT_CONFIG.telemetry, ...parsed.telemetry },
  };
}

/**
 * Migrate v1 config to v2 schema. Backfills missing sections from defaults.
 */
function migrateConfig(parsed) {
  if (!parsed.mode) parsed.mode = DEFAULT_CONFIG.mode;
  if (!parsed.aliases) parsed.aliases = { ...DEFAULT_CONFIG.aliases };
  if (!parsed.modeTiers) parsed.modeTiers = { ...DEFAULT_CONFIG.modeTiers };
  if (!parsed.verification) parsed.verification = { ...DEFAULT_CONFIG.verification };
  // Backfill cheap tier for agents that didn't have it in v1
  for (const agent of ['gemini', 'codex']) {
    if (parsed.models?.[agent] && !parsed.models[agent].cheap) {
      parsed.models[agent].cheap = DEFAULT_CONFIG.models[agent].cheap;
    }
  }
  parsed.version = 2;
  return parsed;
}

let _configCache = null;

export function loadHydraConfig() {
  if (_configCache) return _configCache;
  ensureRuntimeRoot();
  if (HYDRA_IS_PACKAGED) {
    seedRuntimeFile(CONFIG_PATH, EMBEDDED_CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Migrate v1 → v2 if needed
    if (!parsed.version || parsed.version < 2) {
      migrateConfig(parsed);
    }
    _configCache = mergeWithDefaults(parsed);
    return _configCache;
  } catch {
    _configCache = mergeWithDefaults({});
    return _configCache;
  }
}

export function saveHydraConfig(config) {
  ensureRuntimeRoot();
  const merged = mergeWithDefaults(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  _configCache = merged;
  return merged;
}

export function invalidateConfigCache() {
  _configCache = null;
}

/**
 * Get the merged role configuration for a named role.
 * Returns { agent, model, reasoningEffort } with user overrides applied on top of defaults.
 */
export function getRoleConfig(roleName) {
  const cfg = loadHydraConfig();
  const defaults = DEFAULT_CONFIG.roles[roleName] || {};
  const userOverrides = cfg.roles?.[roleName] || {};
  return { ...defaults, ...userOverrides };
}

/**
 * Get the user's API tier for a provider.
 * @param {'openai'|'anthropic'|'google'} provider
 * @returns {string|number} Tier identifier (e.g. 1, 2, 3, 'free')
 */
export function getProviderTier(provider) {
  const cfg = loadHydraConfig();
  const providerCfg = cfg.providers?.[provider] || {};
  const defaults = { openai: 1, anthropic: 1, google: 'free' };
  return providerCfg.tier ?? defaults[provider] ?? 1;
}

// ── Recent Projects ──────────────────────────────────────────────────────────

export function getRecentProjects() {
  ensureRuntimeRoot();
  if (HYDRA_IS_PACKAGED) {
    seedRuntimeFile(RECENT_PROJECTS_PATH, EMBEDDED_RECENT_PROJECTS_PATH, '[]\n');
  }
  try {
    const raw = fs.readFileSync(RECENT_PROJECTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentProject(projectPath) {
  ensureRuntimeRoot();
  const normalized = path.resolve(projectPath);
  const recent = getRecentProjects().filter((p) => path.resolve(p) !== normalized);
  recent.unshift(normalized);
  const trimmed = recent.slice(0, MAX_RECENT);
  fs.writeFileSync(RECENT_PROJECTS_PATH, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
}

// ── Project Detection ────────────────────────────────────────────────────────

function detectProjectName(projectRoot) {
  // Try package.json name first
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch { /* ignore */ }

  // Fall back to directory name
  return path.basename(projectRoot);
}

function isValidProject(dir) {
  const markers = ['package.json', '.git', 'HYDRA.md', 'CLAUDE.md', 'Cargo.toml', 'pyproject.toml', 'go.mod'];
  return markers.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * Resolve the target project.
 *
 * Priority:
 * 1. options.project (explicit path)
 * 2. --project=<path> CLI arg
 * 3. HYDRA_PROJECT env var
 * 4. process.cwd()
 *
 * @param {object} [options]
 * @param {string} [options.project] - Explicit project path
 * @param {boolean} [options.skipValidation] - Skip project marker check
 * @returns {object} Project config with all derived paths
 */
export function resolveProject(options = {}) {
  let projectRoot = options.project || '';

  // Check CLI args for --project=<path> or project=<path>
  if (!projectRoot) {
    for (const arg of process.argv.slice(2)) {
      const match = arg.match(/^(?:--)?project=(.+)$/);
      if (match) {
        projectRoot = match[1];
        break;
      }
    }
  }

  // Check env var
  if (!projectRoot && process.env.HYDRA_PROJECT) {
    projectRoot = process.env.HYDRA_PROJECT;
  }

  // Fall back to cwd
  if (!projectRoot) {
    projectRoot = process.cwd();
  }

  projectRoot = path.resolve(projectRoot);

  if (!options.skipValidation && !isValidProject(projectRoot)) {
    throw new Error(
      `Not a valid project directory: ${projectRoot}\n` +
      'Expected one of: package.json, .git, CLAUDE.md, Cargo.toml, pyproject.toml, go.mod'
    );
  }

  const projectName = detectProjectName(projectRoot);
  const coordDir = path.join(projectRoot, 'docs', 'coordination');

  return {
    projectRoot,
    projectName,
    coordDir,
    statePath: path.join(coordDir, 'AI_SYNC_STATE.json'),
    logPath: path.join(coordDir, 'AI_SYNC_LOG.md'),
    statusPath: path.join(coordDir, 'AI_ORCHESTRATOR_STATUS.json'),
    eventsPath: path.join(coordDir, 'AI_ORCHESTRATOR_EVENTS.ndjson'),
    archivePath: path.join(coordDir, 'AI_SYNC_ARCHIVE.json'),
    runsDir: path.join(coordDir, 'runs'),
    hydraRoot: HYDRA_ROOT,
  };
}

/**
 * Interactive project selection.
 * Prompts user to confirm cwd or pick from recent/enter a path.
 *
 * @returns {Promise<object>} Project config
 */
export async function selectProjectInteractive() {
  const cwd = process.cwd();
  const cwdValid = isValidProject(cwd);
  const recent = getRecentProjects().filter((p) => p !== cwd && fs.existsSync(p));

  if (cwdValid) {
    const name = detectProjectName(cwd);
    const answer = await askLine(`Detected project: ${name} (${cwd}). Work here? (Y/n/browse) `);
    const trimmed = answer.trim().toLowerCase();

    if (!trimmed || trimmed === 'y' || trimmed === 'yes') {
      addRecentProject(cwd);
      return resolveProject({ project: cwd });
    }

    if (trimmed !== 'n' && trimmed !== 'no' && trimmed !== 'browse') {
      // Treat as path
      addRecentProject(trimmed);
      return resolveProject({ project: trimmed });
    }
  }

  // Show recent projects
  if (recent.length > 0) {
    console.log('\nRecent projects:');
    recent.forEach((p, i) => {
      const name = detectProjectName(p);
      console.log(`  ${i + 1}) ${name} (${p})`);
    });
    console.log(`  ${recent.length + 1}) Enter a new path`);

    const choice = await askLine('Select project: ');
    const idx = parseInt(choice, 10) - 1;

    if (idx >= 0 && idx < recent.length) {
      addRecentProject(recent[idx]);
      return resolveProject({ project: recent[idx] });
    }
  }

  // Manual path entry
  const manualPath = await askLine('Enter project path: ');
  if (!manualPath.trim()) {
    throw new Error('No project path provided.');
  }
  addRecentProject(manualPath.trim());
  return resolveProject({ project: manualPath.trim() });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
