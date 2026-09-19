#!/usr/bin/env node
/**
 * Hydra Agent Forge — Multi-model agent creation pipeline.
 *
 * Automates creation of virtual sub-agents through a 5-phase pipeline:
 *   ANALYZE (Gemini) → DESIGN (Claude) → CRITIQUE (Gemini) → REFINE (Claude) → TEST (optional)
 *
 * Each phase uses executeAgent() to invoke the appropriate CLI headlessly.
 * Forged agents are persisted to hydra.config.json (agents.custom) and
 * metadata is stored in docs/coordination/forge/FORGE_REGISTRY.json.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import pc from 'picocolors';
import {
  registerAgent,
  unregisterAgent,
  getAgent,
  listAgents,
  AGENT_TYPE,
  TASK_TYPES,
  classifyTask,
} from './hydra-agents.mjs';
import {
  loadHydraConfig,
  saveHydraConfig,
  invalidateConfigCache,
  HYDRA_ROOT,
  resolveProject,
} from './hydra-config.mjs';
import { executeAgent } from './hydra-shared/agent-executor.mjs';
import { parseJsonLoose } from './hydra-utils.mjs';
import { promptChoice } from './hydra-prompt-choice.mjs';
import {
  sectionHeader,
  label,
  DIM,
  ACCENT,
  SUCCESS,
  WARNING,
  ERROR,
} from './hydra-ui.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

const FORGE_DIR_REL = 'docs/coordination/forge';
const REGISTRY_FILE = 'FORGE_REGISTRY.json';
const SESSIONS_DIR = 'sessions';

const VALID_NAME_RE = /^[a-z][a-z0-9-]*$/;

const PHASE_NAMES = ['analyze', 'design', 'critique', 'refine'];

// ── Storage Helpers ───────────────────────────────────────────────────────────

function forgeDir() {
  return path.join(HYDRA_ROOT, FORGE_DIR_REL);
}

function ensureForgeDir() {
  const dir = forgeDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, SESSIONS_DIR), { recursive: true });
}

export function loadForgeRegistry() {
  try {
    const raw = fs.readFileSync(path.join(forgeDir(), REGISTRY_FILE), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveForgeRegistry(registry) {
  ensureForgeDir();
  fs.writeFileSync(
    path.join(forgeDir(), REGISTRY_FILE),
    JSON.stringify(registry, null, 2) + '\n',
    'utf8',
  );
}

function saveForgeSession(name, session) {
  ensureForgeDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `FORGE_${name}_${ts}.json`;
  fs.writeFileSync(
    path.join(forgeDir(), SESSIONS_DIR, filename),
    JSON.stringify(session, null, 2) + '\n',
    'utf8',
  );
  return filename;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate an agent spec before registration.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
export function validateAgentSpec(spec) {
  const errors = [];
  const warnings = [];

  // Name format
  if (!spec.name || !VALID_NAME_RE.test(spec.name)) {
    errors.push(`Invalid name "${spec.name}": must match /^[a-z][a-z0-9-]*$/`);
  }

  // No collision with existing agents
  if (spec.name) {
    const existing = getAgent(spec.name);
    if (existing && existing.type === AGENT_TYPE.PHYSICAL) {
      errors.push(`Name "${spec.name}" collides with a built-in physical agent`);
    }
  }

  // Base agent must exist and be physical
  if (!spec.baseAgent) {
    errors.push('baseAgent is required');
  } else {
    const base = getAgent(spec.baseAgent);
    if (!base) {
      errors.push(`Base agent "${spec.baseAgent}" does not exist`);
    } else if (base.type !== AGENT_TYPE.PHYSICAL) {
      errors.push(`Base agent "${spec.baseAgent}" must be a physical agent`);
    }
  }

  // All 10 task types need affinity scores
  if (!spec.taskAffinity || typeof spec.taskAffinity !== 'object') {
    errors.push('taskAffinity object is required');
  } else {
    for (const type of TASK_TYPES) {
      const score = spec.taskAffinity[type];
      if (score === undefined || score === null) {
        warnings.push(`Missing affinity for "${type}", will default to 0`);
      } else if (typeof score !== 'number' || score < 0 || score > 1) {
        warnings.push(`Affinity for "${type}" out of range (${score}), will be clamped to 0-1`);
      }
    }

    // Affinity sanity: warn if high score on task type where base agent is weak
    if (spec.baseAgent) {
      const base = getAgent(spec.baseAgent);
      if (base) {
        for (const [type, score] of Object.entries(spec.taskAffinity)) {
          if (score > 0.8 && (base.taskAffinity[type] || 0) < 0.4) {
            warnings.push(
              `High affinity for "${type}" (${score}) but base agent "${spec.baseAgent}" ` +
              `scores low (${base.taskAffinity[type] || 0}) — may underperform`,
            );
          }
        }
      }
    }
  }

  // rolePrompt length
  if (!spec.rolePrompt) {
    errors.push('rolePrompt is required');
  } else {
    if (spec.rolePrompt.length < 100) {
      warnings.push(`rolePrompt is very short (${spec.rolePrompt.length} chars) — consider adding more detail`);
    }
    if (spec.rolePrompt.length > 5000) {
      warnings.push(`rolePrompt is very long (${spec.rolePrompt.length} chars) — may waste context budget`);
    }
  }

  // Display name
  if (!spec.displayName) {
    warnings.push('displayName missing, will use name');
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Codebase Analysis ─────────────────────────────────────────────────────────

/**
 * Scan the current project for forge context.
 * Returns a codebase profile for the ANALYZE phase.
 */
export function analyzeCodebase() {
  const project = resolveProject({ skipValidation: true });
  const root = project.projectRoot;
  const profile = {
    projectName: project.projectName,
    projectRoot: root,
    fileTypes: {},
    hasTests: false,
    packageJson: null,
    claudeMd: false,
    recentCommits: [],
    existingAgents: [],
    coverageGaps: [],
  };

  // Package.json
  try {
    profile.packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch { /* ignore */ }

  // CLAUDE.md / HYDRA.md
  profile.claudeMd = fs.existsSync(path.join(root, 'CLAUDE.md'))
    || fs.existsSync(path.join(root, 'HYDRA.md'));

  // File type distribution (quick scan, top-level + src/)
  const scanDirs = [root];
  const srcDir = path.join(root, 'src');
  const libDir = path.join(root, 'lib');
  if (fs.existsSync(srcDir)) scanDirs.push(srcDir);
  if (fs.existsSync(libDir)) scanDirs.push(libDir);

  for (const dir of scanDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext) profile.fileTypes[ext] = (profile.fileTypes[ext] || 0) + 1;
        }
      }
    } catch { /* ignore */ }
  }

  // Test directory
  const testDir = path.join(root, 'test');
  const testsDir = path.join(root, 'tests');
  profile.hasTests = fs.existsSync(testDir) || fs.existsSync(testsDir)
    || fs.existsSync(path.join(root, '__tests__'));

  // Recent git commits
  try {
    const log = execSync('git log --oneline -10', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    profile.recentCommits = log.trim().split('\n').filter(Boolean);
  } catch { /* no git */ }

  // Existing agents and coverage
  const allAgents = listAgents({ enabled: true });
  for (const agent of allAgents) {
    profile.existingAgents.push({
      name: agent.name,
      type: agent.type,
      topAffinities: Object.entries(agent.taskAffinity || {})
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([t, s]) => `${t}:${(s * 100).toFixed(0)}%`),
    });
  }

  // Find coverage gaps (task types where best agent scores < 0.7)
  for (const type of TASK_TYPES) {
    let bestScore = 0;
    for (const agent of allAgents) {
      const score = agent.taskAffinity[type] || 0;
      if (score > bestScore) bestScore = score;
    }
    if (bestScore < 0.7) {
      profile.coverageGaps.push({ type, bestScore });
    }
  }

  return profile;
}

// ── Phase Prompts ─────────────────────────────────────────────────────────────

function buildAnalyzePrompt(description, profile) {
  return `You are analyzing a codebase to help create a specialized virtual AI agent.

## User's Description
${description || '(No specific description provided — auto-discover gaps)'}

## Codebase Profile
- Project: ${profile.projectName}
- File types: ${Object.entries(profile.fileTypes).map(([ext, n]) => `${ext}(${n})`).join(', ') || 'unknown'}
- Has tests: ${profile.hasTests ? 'yes' : 'no'}
- Has CLAUDE.md: ${profile.claudeMd ? 'yes' : 'no'}
- Package.json: ${profile.packageJson ? `${profile.packageJson.name || 'unnamed'} — deps: ${Object.keys(profile.packageJson.dependencies || {}).slice(0, 10).join(', ')}` : 'none'}
- Recent commits: ${profile.recentCommits.slice(0, 5).join(' | ') || 'none'}

## Existing Agents
${profile.existingAgents.map((a) => `- ${a.name} (${a.type}): ${a.topAffinities.join(', ')}`).join('\n')}

## Coverage Gaps (task types with best agent < 70%)
${profile.coverageGaps.length > 0 ? profile.coverageGaps.map((g) => `- ${g.type}: best=${(g.bestScore * 100).toFixed(0)}%`).join('\n') : 'None — all task types well covered'}

## Task
Analyze this codebase and recommend a specialization focus for a new virtual agent.
${description ? `The user wants: "${description}" — map this to specific task types and recommend a base agent.` : 'Auto-discover the most impactful gap and recommend a specialization.'}

Respond with JSON only:
\`\`\`json
{
  "recommendedFocus": "brief description of recommended agent specialization",
  "suggestedName": "lowercase-hyphenated name",
  "suggestedBase": "claude|gemini|codex",
  "reasoning": "why this specialization and base agent",
  "targetTaskTypes": ["top 2-3 task types this agent should excel at"],
  "suggestedStrengths": ["3-5 keyword strengths"],
  "codebaseInsights": "what about the codebase informed this recommendation"
}
\`\`\``;
}

function buildDesignPrompt(description, analysis, profile) {
  return `You are designing a specialized virtual AI agent for the Hydra multi-agent system.

## User's Intent
${description || analysis.recommendedFocus || 'Auto-discovered specialization'}

## Analysis Results
${JSON.stringify(analysis, null, 2)}

## Agent Design Requirements
Design a complete agent specification following this exact schema:

- **name**: lowercase-hyphenated (e.g. "perf-optimizer")
- **displayName**: Human-readable (e.g. "Performance Optimizer")
- **baseAgent**: Which physical agent to run on ("claude", "gemini", or "codex")
- **strengths**: 3-6 keyword strengths
- **weaknesses**: 2-4 keyword weaknesses
- **tags**: Searchable tags for discovery
- **taskAffinity**: Scores 0.0-1.0 for all 10 task types: planning, architecture, review, refactor, implementation, analysis, testing, research, documentation, security
- **rolePrompt**: Detailed multi-paragraph methodology guide (200-600 words). Include numbered steps, specific techniques, and output structure. This is the most important field — it defines the agent's behavior.

## Style Exemplars (existing sub-agents)
Here are examples of good rolePrompts and affinity patterns:
- security-reviewer (gemini): Security focus, OWASP methodology, severity ratings, remediation guidance. Scores: security=0.98, review=0.92, analysis=0.85.
- test-writer (codex): Test strategy, edge cases, coverage. Scores: testing=0.98, implementation=0.65.
- researcher (gemini): Systematic exploration, hypothesis-driven, evidence-based. Scores: research=0.98, analysis=0.90.

## Rules
1. The agent's top affinity should be 0.95-0.98 (not 1.0)
2. Base agent weaknesses should be reflected — don't give high affinity where the base agent scores low
3. rolePrompt must be specific to the specialization, not generic
4. Include concrete techniques and output structure in rolePrompt

Respond with JSON only:
\`\`\`json
{
  "name": "string",
  "displayName": "string",
  "baseAgent": "string",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "tags": ["string"],
  "taskAffinity": {
    "planning": 0.0,
    "architecture": 0.0,
    "review": 0.0,
    "refactor": 0.0,
    "implementation": 0.0,
    "analysis": 0.0,
    "testing": 0.0,
    "research": 0.0,
    "documentation": 0.0,
    "security": 0.0
  },
  "rolePrompt": "string",
  "enabled": true
}
\`\`\``;
}

function buildCritiquePrompt(spec, analysis) {
  return `You are reviewing a proposed virtual agent specification for the Hydra multi-agent system.

## Proposed Agent Spec
${JSON.stringify(spec, null, 2)}

## Original Analysis
${JSON.stringify(analysis, null, 2)}

## Review Criteria
1. **Affinity realism**: Do the taskAffinity scores make sense for the base agent's capabilities?
2. **rolePrompt quality**: Is it specific, actionable, and well-structured? Does it include concrete techniques?
3. **Overlap**: Does this agent duplicate existing agents without enough differentiation?
4. **Base agent suitability**: Is the chosen base agent (${spec.baseAgent}) the best fit?
5. **Naming**: Is the name clear, descriptive, and follows conventions?
6. **Strengths/weaknesses**: Are they accurate and balanced?

## Existing Agents for Overlap Check
Physical: claude (architect), gemini (analyst), codex (implementer)
Virtual: security-reviewer (gemini), test-writer (codex), doc-generator (claude), researcher (gemini), evolve-researcher (gemini)

Respond with JSON only:
\`\`\`json
{
  "overallAssessment": "good|needs-work|poor",
  "issues": [{"severity": "error|warning|info", "field": "string", "message": "string"}],
  "suggestions": ["concrete improvement suggestions"],
  "affinityAdjustments": {"taskType": 0.0},
  "rolePromptFeedback": "specific feedback on the rolePrompt",
  "nameAlternatives": ["alternative names if current is weak"],
  "baseAgentComment": "is the base agent choice good?"
}
\`\`\``;
}

function buildRefinePrompt(spec, critique) {
  return `You are refining a virtual agent specification based on peer review.

## Current Spec
${JSON.stringify(spec, null, 2)}

## Critique Feedback
${JSON.stringify(critique, null, 2)}

## Instructions
1. Incorporate all valid suggestions from the critique
2. Fix any issues marked as "error" severity
3. Consider "warning" suggestions — apply if they improve quality
4. Polish the rolePrompt — ensure it's specific, well-structured, and actionable
5. Adjust affinities based on the suggested adjustments (if they make sense)
6. Keep the agent's core identity intact — don't completely change its focus

Respond with the COMPLETE refined spec as JSON only:
\`\`\`json
{
  "name": "string",
  "displayName": "string",
  "baseAgent": "string",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "tags": ["string"],
  "taskAffinity": {
    "planning": 0.0,
    "architecture": 0.0,
    "review": 0.0,
    "refactor": 0.0,
    "implementation": 0.0,
    "analysis": 0.0,
    "testing": 0.0,
    "research": 0.0,
    "documentation": 0.0,
    "security": 0.0
  },
  "rolePrompt": "string",
  "enabled": true
}
\`\`\``;
}

// ── Normalize / Clamp ─────────────────────────────────────────────────────────

function normalizeSpec(raw) {
  const spec = { ...raw };

  // Ensure name is lowercase-hyphenated
  if (spec.name) {
    spec.name = String(spec.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  // Clamp affinities to 0-1, ensure all task types present
  if (spec.taskAffinity && typeof spec.taskAffinity === 'object') {
    for (const type of TASK_TYPES) {
      const val = spec.taskAffinity[type];
      if (val === undefined || val === null) {
        spec.taskAffinity[type] = 0;
      } else {
        spec.taskAffinity[type] = Math.max(0, Math.min(1, Number(val) || 0));
      }
    }
    // Remove extraneous keys
    for (const key of Object.keys(spec.taskAffinity)) {
      if (!TASK_TYPES.includes(key)) {
        delete spec.taskAffinity[key];
      }
    }
  }

  // Ensure arrays
  if (!Array.isArray(spec.strengths)) spec.strengths = [];
  if (!Array.isArray(spec.weaknesses)) spec.weaknesses = [];
  if (!Array.isArray(spec.tags)) spec.tags = [];

  // Ensure enabled
  spec.enabled = spec.enabled !== false;
  spec.type = AGENT_TYPE.VIRTUAL;

  return spec;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

/**
 * Run the 4-phase forge pipeline (ANALYZE → DESIGN → CRITIQUE → REFINE).
 *
 * @param {string} description - User's intent description
 * @param {object} [codebaseCtx] - Pre-built codebase profile (or auto-scan)
 * @param {object} [opts]
 * @param {number} [opts.phaseTimeoutMs] - Timeout per phase
 * @param {Function} [opts.onPhase] - Callback: (phaseName, status, phaseData?) => void
 * @returns {Promise<{spec: object, phases: object, session: object}>}
 */
export async function runForgePipeline(description, codebaseCtx = null, opts = {}) {
  const cfg = loadHydraConfig();
  const forgeCfg = cfg.forge || {};
  const timeoutMs = opts.phaseTimeoutMs || forgeCfg.phaseTimeoutMs || 300_000;
  const onPhase = opts.onPhase || (() => {});
  const profile = codebaseCtx || analyzeCodebase();
  const phases = {};
  const session = {
    description,
    startedAt: new Date().toISOString(),
    phasesRun: [],
  };

  // Phase 1: ANALYZE (Gemini)
  onPhase('analyze', 'running');
  const analyzePrompt = buildAnalyzePrompt(description, profile);
  const analyzeResult = await executeAgent('gemini', analyzePrompt, {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
    hubCwd: process.cwd(),
    hubProject: path.basename(process.cwd()),
    hubAgent: 'gemini-forge',
  });
  const analysis = parseJsonLoose(analyzeResult.output) || {
    recommendedFocus: description || 'general purpose',
    suggestedName: 'custom-agent',
    suggestedBase: 'claude',
    reasoning: 'Fallback — analysis phase failed to produce structured output',
    targetTaskTypes: ['implementation'],
    suggestedStrengths: ['general'],
  };
  phases.analyze = { result: analysis, durationMs: analyzeResult.durationMs, ok: analyzeResult.ok };
  session.phasesRun.push('analyze');
  onPhase('analyze', 'done', phases.analyze);

  // Phase 2: DESIGN (Claude)
  onPhase('design', 'running');
  const designPrompt = buildDesignPrompt(description, analysis, profile);
  const designResult = await executeAgent('claude', designPrompt, {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
    hubCwd: process.cwd(),
    hubProject: path.basename(process.cwd()),
    hubAgent: 'claude-forge',
  });

  let designOutput = designResult.output;
  // Claude JSON output format: try to extract result field
  try {
    const parsed = JSON.parse(designOutput);
    if (parsed.result) designOutput = parsed.result;
  } catch { /* use raw */ }

  let designSpec = parseJsonLoose(designOutput);
  if (!designSpec || !designSpec.name) {
    // Fallback: build minimal spec from analysis
    designSpec = {
      name: analysis.suggestedName || 'custom-agent',
      displayName: (analysis.suggestedName || 'Custom Agent').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      baseAgent: analysis.suggestedBase || 'claude',
      strengths: analysis.suggestedStrengths || ['general'],
      weaknesses: ['scope-limited'],
      tags: analysis.targetTaskTypes || [],
      taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, (analysis.targetTaskTypes || []).includes(t) ? 0.85 : 0.3])),
      rolePrompt: `You are a specialized agent for: ${description || analysis.recommendedFocus}. Follow best practices and provide structured, actionable output.`,
      enabled: true,
    };
  }
  designSpec = normalizeSpec(designSpec);
  phases.design = { result: designSpec, durationMs: designResult.durationMs, ok: designResult.ok };
  session.phasesRun.push('design');
  onPhase('design', 'done', phases.design);

  // Phase 3: CRITIQUE (Gemini)
  onPhase('critique', 'running');
  const critiquePrompt = buildCritiquePrompt(designSpec, analysis);
  const critiqueResult = await executeAgent('gemini', critiquePrompt, {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
    hubCwd: process.cwd(),
    hubProject: path.basename(process.cwd()),
    hubAgent: 'gemini-forge',
  });
  const critique = parseJsonLoose(critiqueResult.output) || {
    overallAssessment: 'good',
    issues: [],
    suggestions: [],
    affinityAdjustments: {},
    rolePromptFeedback: 'No structured critique available — using design as-is.',
  };
  phases.critique = { result: critique, durationMs: critiqueResult.durationMs, ok: critiqueResult.ok };
  session.phasesRun.push('critique');
  onPhase('critique', 'done', phases.critique);

  // Phase 4: REFINE (Claude)
  onPhase('refine', 'running');
  const refinePrompt = buildRefinePrompt(designSpec, critique);
  const refineResult = await executeAgent('claude', refinePrompt, {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
    hubCwd: process.cwd(),
    hubProject: path.basename(process.cwd()),
    hubAgent: 'claude-forge',
  });

  let refineOutput = refineResult.output;
  try {
    const parsed = JSON.parse(refineOutput);
    if (parsed.result) refineOutput = parsed.result;
  } catch { /* use raw */ }

  let finalSpec = parseJsonLoose(refineOutput);
  if (!finalSpec || !finalSpec.name) {
    // Fallback: apply critique adjustments to design spec manually
    finalSpec = { ...designSpec };
    if (critique.affinityAdjustments) {
      for (const [type, score] of Object.entries(critique.affinityAdjustments)) {
        if (TASK_TYPES.includes(type) && typeof score === 'number') {
          finalSpec.taskAffinity[type] = Math.max(0, Math.min(1, score));
        }
      }
    }
  }
  finalSpec = normalizeSpec(finalSpec);
  phases.refine = { result: finalSpec, durationMs: refineResult.durationMs, ok: refineResult.ok };
  session.phasesRun.push('refine');
  onPhase('refine', 'done', phases.refine);

  session.completedAt = new Date().toISOString();
  return { spec: finalSpec, phases, session };
}

// ── Test Phase ────────────────────────────────────────────────────────────────

/**
 * Generate a sample prompt matching the agent's top affinity type.
 */
export function generateSamplePrompt(spec, profile) {
  const topType = Object.entries(spec.taskAffinity || {})
    .sort(([, a], [, b]) => b - a)[0]?.[0] || 'implementation';

  const projectName = profile?.projectName || 'the project';
  const prompts = {
    planning: `Create a plan for improving the ${projectName} test infrastructure. Break it into phases with clear milestones.`,
    architecture: `Review the architecture of ${projectName} and identify potential scalability bottlenecks.`,
    review: `Review the most recently changed files in ${projectName} for code quality, potential bugs, and best practices.`,
    refactor: `Identify the top 3 refactoring opportunities in ${projectName} and propose specific changes.`,
    implementation: `Implement a utility function for ${projectName} that validates configuration objects.`,
    analysis: `Analyze the dependency graph of ${projectName} and identify circular dependencies or unnecessary coupling.`,
    testing: `Write tests for the most critical untested functions in ${projectName}.`,
    research: `Research the codebase of ${projectName} and document how errors propagate through the system.`,
    documentation: `Generate API documentation for the main exported functions of ${projectName}.`,
    security: `Perform a security audit of ${projectName} focusing on input validation and injection vulnerabilities.`,
  };

  return prompts[topType] || prompts.implementation;
}

/**
 * Test a forged agent by temporarily registering it and running a sample prompt.
 */
export async function testForgedAgent(spec, samplePrompt = null, opts = {}) {
  const profile = opts.profile || analyzeCodebase();
  const prompt = samplePrompt || generateSamplePrompt(spec, profile);
  const timeoutMs = opts.timeoutMs || 120_000;

  // Build the full prompt with rolePrompt injected
  const fullPrompt = `${spec.rolePrompt}\n\n---\n\nTask:\n${prompt}`;

  const result = await executeAgent(spec.baseAgent, fullPrompt, {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
  });

  return {
    ok: result.ok,
    output: result.output,
    durationMs: result.durationMs,
    prompt,
    error: result.error,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Persist a forged agent to config and registry.
 */
export function persistForgedAgent(spec, session = {}) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();

  // Add to agents.custom in config
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.custom) cfg.agents.custom = {};

  cfg.agents.custom[spec.name] = {
    baseAgent: spec.baseAgent,
    displayName: spec.displayName,
    label: `${spec.displayName} (${spec.baseAgent})`,
    strengths: spec.strengths,
    weaknesses: spec.weaknesses,
    tags: spec.tags,
    taskAffinity: spec.taskAffinity,
    rolePrompt: spec.rolePrompt,
    enabled: spec.enabled !== false,
  };

  saveHydraConfig(cfg);

  // Register in the live registry
  try {
    const existing = getAgent(spec.name);
    if (existing) unregisterAgent(spec.name);
  } catch { /* ignore */ }

  registerAgent(spec.name, {
    ...spec,
    type: AGENT_TYPE.VIRTUAL,
  });

  // Update forge metadata registry
  const registry = loadForgeRegistry();
  registry[spec.name] = {
    forgedAt: new Date().toISOString(),
    description: session.description || '',
    phasesRun: session.phasesRun || PHASE_NAMES,
    testResult: session.testResult || null,
    version: (registry[spec.name]?.version || 0) + 1,
  };
  saveForgeRegistry(registry);

  // Save session transcript
  if (session.phasesRun) {
    saveForgeSession(spec.name, session);
  }

  return spec;
}

/**
 * Remove a forged agent from config and registry.
 */
export function removeForgedAgent(name) {
  const lower = String(name).toLowerCase();

  // Remove from live registry
  try {
    unregisterAgent(lower);
  } catch { /* may not be registered */ }

  // Remove from config
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  if (cfg.agents?.custom?.[lower]) {
    delete cfg.agents.custom[lower];
    saveHydraConfig(cfg);
  }

  // Remove from forge metadata
  const registry = loadForgeRegistry();
  if (registry[lower]) {
    delete registry[lower];
    saveForgeRegistry(registry);
  }

  return true;
}

/**
 * List all forged agents with metadata.
 */
export function listForgedAgents() {
  const registry = loadForgeRegistry();
  const cfg = loadHydraConfig();
  const custom = cfg.agents?.custom || {};
  const results = [];

  for (const [name, meta] of Object.entries(registry)) {
    const spec = custom[name] || getAgent(name);
    results.push({
      name,
      displayName: spec?.displayName || name,
      baseAgent: spec?.baseAgent || 'unknown',
      enabled: spec?.enabled !== false,
      forgedAt: meta.forgedAt,
      version: meta.version || 1,
      description: meta.description || '',
      topAffinities: spec?.taskAffinity
        ? Object.entries(spec.taskAffinity)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([t, s]) => `${t}:${(s * 100).toFixed(0)}%`)
        : [],
    });
  }

  return results;
}

// ── Non-Interactive API ───────────────────────────────────────────────────────

/**
 * Non-interactive agent creation (for MCP use).
 * Runs the full pipeline with defaults and persists the result.
 */
export async function forgeAgent(description, opts = {}) {
  const profile = analyzeCodebase();
  const { spec, phases, session } = await runForgePipeline(description, profile, opts);

  // Override name if provided
  if (opts.name) {
    spec.name = String(opts.name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }
  if (opts.baseAgent) {
    spec.baseAgent = opts.baseAgent;
  }

  // Validate
  const validation = validateAgentSpec(spec);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings, spec };
  }

  // Optional test
  let testResult = null;
  if (!opts.skipTest) {
    try {
      testResult = await testForgedAgent(spec, null, { profile });
      session.testResult = { ok: testResult.ok, durationMs: testResult.durationMs };
    } catch { /* test failure non-fatal */ }
  }

  // Persist
  persistForgedAgent(spec, session);

  return {
    ok: true,
    spec,
    validation,
    testResult,
    phases: Object.fromEntries(
      Object.entries(phases).map(([k, v]) => [k, { ok: v.ok, durationMs: v.durationMs }]),
    ),
  };
}

// ── Interactive Wizard ────────────────────────────────────────────────────────

/**
 * Interactive forge wizard for the operator console.
 *
 * @param {readline.Interface} rl - Operator readline instance
 * @param {string} [description] - Pre-filled description
 */
export async function runForgeWizard(rl, description = '') {
  console.log('');
  console.log(sectionHeader('Agent Forge'));
  console.log(DIM('  Multi-model agent creation pipeline'));
  console.log('');

  // Step 1: Intent
  let intent = description;
  if (!intent) {
    const { value } = await promptChoice(rl, {
      title: 'Agent Forge',
      context: { Mode: 'Create a new virtual sub-agent' },
      choices: [
        { label: 'Describe your needs', value: 'describe', hint: 'tell us what you want' },
        { label: 'Auto-discover gaps', value: 'discover', hint: 'scan codebase for opportunities' },
        { label: 'Quick create', value: 'quick', hint: 'minimal prompts, fast result', freeform: true },
      ],
    });

    if (value === 'describe') {
      const { value: desc } = await promptChoice(rl, {
        title: 'Describe Agent',
        context: { Prompt: 'What should this agent specialize in?' },
        choices: [
          { label: 'Type your description', value: '', freeform: true },
        ],
      });
      intent = desc;
    } else if (value === 'discover') {
      intent = '';
    } else if (typeof value === 'string' && value.length > 3) {
      // Freeform quick create
      intent = value;
    }
  }

  // Step 2: Analyze
  console.log('');
  console.log(`  ${ACCENT('\u25B6')} Phase 1/4: ${pc.bold('ANALYZE')} ${DIM('(Gemini scanning codebase...)')}`);
  const profile = analyzeCodebase();

  // Run pipeline
  const phaseStatus = {};
  const { spec, phases, session } = await runForgePipeline(intent, profile, {
    onPhase: (name, status, phaseData) => {
      phaseStatus[name] = status;
      if (status === 'running') {
        const idx = PHASE_NAMES.indexOf(name) + 1;
        const agent = name === 'analyze' || name === 'critique' ? 'Gemini' : 'Claude';
        console.log(`  ${ACCENT('\u25B6')} Phase ${idx}/4: ${pc.bold(name.toUpperCase())} ${DIM(`(${agent}...)`)}`);
      } else if (status === 'done') {
        const idx = PHASE_NAMES.indexOf(name) + 1;
        const ms = phaseData?.durationMs;
        console.log(`  ${SUCCESS('\u2713')} Phase ${idx}/4: ${name.toUpperCase()} ${DIM(ms ? `(${(ms / 1000).toFixed(1)}s)` : '')}`);
      }
    },
  });

  // Step 3: Spec preview
  console.log('');
  console.log(sectionHeader('Forged Agent'));
  console.log(`  ${pc.bold('Name:')}      ${ACCENT(spec.name)}`);
  console.log(`  ${pc.bold('Display:')}   ${spec.displayName}`);
  console.log(`  ${pc.bold('Base:')}      ${spec.baseAgent}`);
  console.log(`  ${pc.bold('Strengths:')} ${spec.strengths.join(', ')}`);
  console.log(`  ${pc.bold('Tags:')}      ${spec.tags.join(', ')}`);

  // Top affinities
  const topAffinities = Object.entries(spec.taskAffinity)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  console.log(`  ${pc.bold('Top Affinities:')}`);
  for (const [type, score] of topAffinities) {
    const bar = '\u2588'.repeat(Math.round(score * 20));
    console.log(`    ${type.padEnd(16)} ${DIM(bar)} ${(score * 100).toFixed(0)}%`);
  }

  // RolePrompt preview
  const promptLines = spec.rolePrompt.split('\n').slice(0, 4);
  console.log(`  ${pc.bold('Role Prompt')} ${DIM(`(${spec.rolePrompt.length} chars):`)}`)
  for (const l of promptLines) console.log(`    ${DIM(l)}`);
  if (spec.rolePrompt.split('\n').length > 4) console.log(`    ${DIM('...')}`);

  // Critique summary
  if (phases.critique?.result) {
    const c = phases.critique.result;
    const issueCount = c.issues?.length || 0;
    console.log('');
    console.log(`  ${pc.bold('Critique:')} ${c.overallAssessment || 'n/a'} ${DIM(`(${issueCount} issue${issueCount !== 1 ? 's' : ''})`)}`);
    if (c.issues?.length) {
      for (const issue of c.issues.slice(0, 3)) {
        const icon = issue.severity === 'error' ? ERROR('\u2718') : WARNING('\u26A0');
        console.log(`    ${icon} ${issue.message}`);
      }
    }
  }

  // Validation
  const validation = validateAgentSpec(spec);
  if (!validation.valid) {
    console.log('');
    console.log(`  ${ERROR('Validation errors:')}`);
    for (const err of validation.errors) console.log(`    ${ERROR('\u2718')} ${err}`);
  }
  if (validation.warnings.length) {
    for (const w of validation.warnings) console.log(`    ${WARNING('\u26A0')} ${w}`);
  }

  // Step 4: Approve
  console.log('');
  const { value: action } = await promptChoice(rl, {
    title: 'Approve Agent',
    context: {
      Agent: `${spec.name} (${spec.displayName})`,
      Validation: validation.valid ? 'passed' : `${validation.errors.length} errors`,
    },
    choices: [
      { label: 'Register agent', value: 'approve', hint: 'save to config' },
      { label: 'Test first', value: 'test', hint: 'run a sample prompt' },
      { label: 'Re-forge', value: 'reforge', hint: 'run pipeline again' },
      { label: 'Cancel', value: 'cancel' },
    ],
  });

  if (action === 'cancel') {
    console.log(`  ${DIM('Forge cancelled.')}`);
    return null;
  }

  if (action === 'reforge') {
    return runForgeWizard(rl, intent);
  }

  // Optional test
  if (action === 'test') {
    console.log('');
    console.log(`  ${ACCENT('\u25B6')} Phase 5: ${pc.bold('TEST')} ${DIM(`(${spec.baseAgent}...)`)}`);
    try {
      const testResult = await testForgedAgent(spec, null, { profile });
      session.testResult = { ok: testResult.ok, durationMs: testResult.durationMs };
      console.log(`  ${testResult.ok ? SUCCESS('\u2713') : ERROR('\u2718')} Test ${testResult.ok ? 'passed' : 'failed'} ${DIM(`(${(testResult.durationMs / 1000).toFixed(1)}s)`)}`);
      if (testResult.output) {
        const preview = testResult.output.split('\n').slice(0, 5);
        for (const l of preview) console.log(`    ${DIM(l.slice(0, 100))}`);
        if (testResult.output.split('\n').length > 5) console.log(`    ${DIM('...')}`);
      }
    } catch (err) {
      console.log(`  ${ERROR('\u2718')} Test error: ${err.message}`);
    }

    console.log('');
    const { value: postTest } = await promptChoice(rl, {
      title: 'After Test',
      choices: [
        { label: 'Register agent', value: 'approve' },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (postTest === 'cancel') {
      console.log(`  ${DIM('Forge cancelled.')}`);
      return null;
    }
  }

  // Persist
  if (!validation.valid) {
    console.log(`  ${ERROR('Cannot register:')} spec has validation errors.`);
    return null;
  }

  persistForgedAgent(spec, session);
  console.log('');
  console.log(`  ${SUCCESS('\u2713')} Agent ${ACCENT(spec.name)} registered successfully!`);
  console.log(`  ${DIM('View with: :agents info ' + spec.name)}`);
  console.log('');

  return spec;
}
