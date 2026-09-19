#!/usr/bin/env node
/**
 * Hydra Nightly Discovery — AI-powered task suggestion via agent analysis.
 *
 * Dispatches an agent (default: gemini) to analyze the codebase and propose
 * improvement tasks. Returns discovered items as ScannedTask[] for merging
 * into the nightly pipeline.
 *
 * Non-blocking: agent failures return [] without stopping the pipeline.
 */

import { loadHydraConfig } from './hydra-config.mjs';
import { classifyTask, bestAgentFor } from './hydra-agents.mjs';
import { classifyPrompt } from './hydra-utils.mjs';
import { taskToSlug } from './hydra-tasks-scanner.mjs';
import { executeAgentWithRecovery } from './hydra-shared/agent-executor.mjs';
import { getAgentInstructionFile } from './hydra-sync-md.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';
import pc from 'picocolors';

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info:  (msg) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok:    (msg) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn:  (msg) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  dim:   (msg) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

// ── Prompt Builder ──────────────────────────────────────────────────────────

function buildDiscoveryPrompt(projectRoot, opts = {}) {
  const {
    existingTasks = [],
    focus = [],
    instructionFile = 'CLAUDE.md',
    profile = 'nightly',
    extraContext = '',
  } = opts;

  const existingList = existingTasks.length > 0
    ? existingTasks.map(t => `- ${t}`).join('\n')
    : '(none)';

  const focusSection = focus.length > 0
    ? `\n## Focus Areas\nPrioritize tasks related to: ${focus.join(', ')}\n`
    : '';

  const header = profile === 'actualize'
    ? '# Hydra Self-Actualization — Suggest Improvement Tasks'
    : '# Codebase Analysis — Suggest Improvement Tasks';

  const guidelineBlock = profile === 'actualize'
    ? `## Guidelines
- Propose 3-6 suggestions, sorted by priority
- Prefer high-leverage improvements: self-awareness, robustness, diagnostics, guardrails, developer experience
- It is OK to propose new commands/endpoints/tools, but keep each task bounded and testable
- Avoid sweeping rewrites; prefer incremental changes with tests
- Do NOT suggest tasks already in the queue above`
    : `## Guidelines
- Focus on concrete, achievable tasks (30 min or less each)
- Prefer bug fixes, missing error handling, test gaps, and code quality
- Do NOT suggest major architectural changes or new features
- Do NOT suggest tasks already in the queue above
- Return 3-5 suggestions, sorted by priority`;

  const ctxBlock = extraContext
    ? `\n## Extra Context\n${extraContext}\n`
    : '';

  return `${header}

You are analyzing the codebase at \`${projectRoot}\` to suggest concrete, actionable improvement tasks.

## Instructions
1. Read the project's \`${instructionFile}\` to understand the codebase architecture and conventions
2. Explore key source files to identify areas for improvement
3. Return a JSON array of task suggestions

## Already Queued (skip these)
${existingList}
${focusSection}
${ctxBlock}
## Output Format
Return ONLY a JSON array (no markdown fences, no prose). Each item:
\`\`\`json
[
  {
    "title": "Short imperative task title",
    "description": "1-2 sentence explanation of what to do and why",
    "priority": "high|medium|low",
    "taskType": "implementation|refactor|testing|security|documentation|analysis"
  }
]
\`\`\`

${guidelineBlock}`;
}

// ── JSON Extraction ─────────────────────────────────────────────────────────

function extractJsonArray(text) {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* continue */ }

  // Try extracting from markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch { /* continue */ }
  }

  // Try regex for [...] blocks
  const bracketMatch = text.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      const parsed = JSON.parse(bracketMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* continue */ }
  }

  return null;
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Run AI discovery to suggest improvement tasks for the nightly pipeline.
 *
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} [opts]
 * @param {string} [opts.agent='gemini'] - Agent to use for discovery
 * @param {number} [opts.maxSuggestions=5] - Max tasks to return
 * @param {string[]} [opts.focus=[]] - Optional focus areas
 * @param {number} [opts.timeoutMs=300000] - Agent timeout
 * @param {string[]} [opts.existingTasks=[]] - Already-queued task titles for dedup
 * @returns {Promise<import('./hydra-tasks-scanner.mjs').ScannedTask[]>}
 */
export async function runDiscovery(projectRoot, opts = {}) {
  const cfg = loadHydraConfig();
  const discoveryCfg = cfg.nightly?.aiDiscovery || {};

  const agent = opts.agent || discoveryCfg.agent || 'gemini';
  const maxSuggestions = opts.maxSuggestions || discoveryCfg.maxSuggestions || 5;
  const focus = opts.focus || discoveryCfg.focus || [];
  const timeoutMs = opts.timeoutMs || discoveryCfg.timeoutMs || 5 * 60 * 1000;
  const existingTasks = opts.existingTasks || [];
  const profile = opts.profile || 'nightly';
  const extraContext = opts.extraContext || '';

  const instructionFile = getAgentInstructionFile(agent, projectRoot);
  const prompt = buildDiscoveryPrompt(projectRoot, {
    existingTasks,
    focus,
    instructionFile,
    profile,
    extraContext,
  });

  log.info(`AI Discovery: dispatching ${agent} to analyze codebase...`);

  const handle = recordCallStart(agent, 'discovery');
  let result;
  try {
    result = await executeAgentWithRecovery(agent, prompt, {
      cwd: projectRoot,
      timeoutMs,
    });
  } catch (err) {
    recordCallError(handle, err);
    log.warn(`Discovery agent failed: ${err.message}`);
    return [];
  }

  if (!result.ok) {
    recordCallError(handle, new Error(result.error || 'agent returned non-ok'));
    log.warn(`Discovery agent returned error: ${result.error || 'unknown'}`);
    return [];
  }

  recordCallComplete(handle, result);

  // Parse response
  const output = result.stdout || result.output || '';
  const items = extractJsonArray(output);

  if (!items || items.length === 0) {
    log.warn('Discovery: could not parse task suggestions from agent output');
    return [];
  }

  // Convert to ScannedTask shape
  const tasks = [];
  for (const item of items.slice(0, maxSuggestions)) {
    if (!item.title || typeof item.title !== 'string') continue;

    const title = item.title.trim();
    const slug = taskToSlug(title);
    const taskType = item.taskType || classifyTask(title);
    const suggestedAgent = bestAgentFor(taskType);
    const { tier } = classifyPrompt(title);

    tasks.push({
      id: `ai-discovery:${slug}`,
      title,
      slug,
      source: 'ai-discovery',
      sourceRef: `${agent}-discovery`,
      taskType,
      suggestedAgent,
      complexity: tier,
      priority: item.priority || 'medium',
      body: item.description || null,
      issueNumber: null,
    });
  }

  log.ok(`Discovery: ${tasks.length} task(s) suggested`);
  for (const t of tasks) {
    log.dim(`  - [${t.priority}] ${t.title}`);
  }

  return tasks;
}
