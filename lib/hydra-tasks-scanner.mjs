#!/usr/bin/env node
/**
 * Hydra Tasks Scanner — Aggregate work items from multiple sources.
 *
 * Sources:
 *   1. TODO/FIXME/HACK/XXX comments in code (via git grep)
 *   2. Unchecked items from docs/TODO.md
 *   3. GitHub issues (via gh CLI)
 *   4. User-provided freeform tasks
 *
 * Exports:
 *   scanAllSources(), scanTodoComments(), scanTodoMd(), scanGitHubIssues(),
 *   createUserTask(), deduplicateTasks(), prioritizeTasks()
 *
 * Usage:
 *   import { scanAllSources } from './hydra-tasks-scanner.mjs';
 *   const tasks = await scanAllSources(projectRoot);
 */

import fs from 'fs';
import path from 'path';
import spawn from 'cross-spawn';
import { classifyTask, bestAgentFor } from './hydra-agents.mjs';
import { classifyPrompt } from './hydra-utils.mjs';
import { listIssues, isGhAvailable, isGhAuthenticated } from './hydra-github.mjs';
import { loadHydraConfig } from './hydra-config.mjs';
import pc from 'picocolors';

// ── ScannedTask Shape ───────────────────────────────────────────────────────

/**
 * @typedef {object} ScannedTask
 * @property {string} id           - Unique identifier (source:ref)
 * @property {string} title        - Human-readable title
 * @property {string} slug         - Branch-safe slug
 * @property {string} source       - 'todo-comment' | 'todo-md' | 'github-issue' | 'user-input'
 * @property {string} sourceRef    - 'lib/foo.mjs:42' | 'Backlog Tier 1' | '#42' | 'manual'
 * @property {string} taskType     - From classifyTask(): implementation, testing, etc.
 * @property {string} suggestedAgent - From bestAgentFor()
 * @property {string} complexity   - From classifyPrompt(): simple | moderate | complex
 * @property {string} priority     - 'high' | 'medium' | 'low'
 * @property {string|null} body    - Extended description (GitHub issue body, or null)
 * @property {number|null} issueNumber - GitHub issue # (or null)
 */

// ── Slug Generator ──────────────────────────────────────────────────────────

/**
 * Generate a URL-safe branch slug from a task description.
 * @param {string} task
 * @returns {string}
 */
export function taskToSlug(task) {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')     // Remove special chars
    .replace(/\s+/g, '-')              // Spaces to hyphens
    .replace(/-+/g, '-')               // Collapse multiple hyphens
    .replace(/^-|-$/g, '')             // Trim leading/trailing hyphens
    .slice(0, 50);                     // Cap length
}

// ── Priority Heuristics ─────────────────────────────────────────────────────

const HIGH_PRIORITY_PATTERNS = [
  /\bFIXME\b/i,
  /\bbug\b/i,
  /\bcrash\b/i,
  /\bbroken\b/i,
  /\bcritical\b/i,
  /\bsecurity\b/i,
  /\brace condition\b/i,
];

const LOW_PRIORITY_PATTERNS = [
  /\bHACK\b/i,
  /\bXXX\b/i,
  /\bcleanup\b/i,
  /\brefactor\b/i,
  /\bnit\b/i,
  /\bcosmetic\b/i,
  /\bdocs?\b/i,
];

function classifyPriority(text) {
  if (HIGH_PRIORITY_PATTERNS.some(p => p.test(text))) return 'high';
  if (LOW_PRIORITY_PATTERNS.some(p => p.test(text))) return 'low';
  return 'medium';
}

// ── Classify & Build Task ───────────────────────────────────────────────────

function buildTask(id, title, source, sourceRef, body = null, issueNumber = null) {
  const taskType = classifyTask(title);
  const agent = bestAgentFor(taskType);
  const { tier } = classifyPrompt(title);
  const priority = classifyPriority(title);

  return {
    id,
    title,
    slug: taskToSlug(title),
    source,
    sourceRef,
    taskType,
    suggestedAgent: agent,
    complexity: tier,
    priority,
    body,
    issueNumber,
  };
}

// ── Source 1: TODO/FIXME Comments in Code ────────────────────────────────────

/**
 * Scan code for TODO/FIXME/HACK/XXX comments using git grep.
 * Fast, respects .gitignore.
 *
 * @param {string} projectRoot
 * @returns {ScannedTask[]}
 */
export function scanTodoComments(projectRoot) {
  const result = spawn.sync('git', [
    'grep', '-n', '-i', '-E', '\\b(TODO|FIXME|HACK|XXX)\\b',
    '--', '*.mjs', '*.js', '*.ts', '*.tsx', '*.jsx', '*.py', '*.rs', '*.go', '*.sh', '*.yml', '*.yaml', '*.sql', '.env.example',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 15_000,
  });

  if (result.status !== 0 || !result.stdout) return [];

  const tasks = [];
  const seen = new Set();

  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;

    // Format: file:line:content
    const match = line.match(/^(.+?):(\d+):(.+)$/);
    if (!match) continue;

    const [, filePath, lineNum, content] = match;

    // Skip test files, node_modules, coordination docs
    if (filePath.includes('node_modules/')) continue;
    if (filePath.includes('docs/coordination/')) continue;

    // Extract the comment text after the marker
    const markerMatch = content.match(/((?:\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b)[\s:(]*(.*))/i);
    if (!markerMatch) continue;

    const fullComment = markerMatch[1].trim();
    const commentBody = markerMatch[2]?.trim() || fullComment;

    // Skip very short/meaningless comments
    if (commentBody.length < 5) continue;

    // Dedup by file+comment
    const dedupeKey = `${filePath}:${commentBody.slice(0, 40)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const title = commentBody.replace(/\*\/\s*$/, '').trim();
    const ref = `${filePath}:${lineNum}`;
    const id = `todo-comment:${ref}`;

    tasks.push(buildTask(id, title, 'todo-comment', ref));
  }

  return tasks;
}

// ── Source 2: docs/TODO.md ──────────────────────────────────────────────────

/**
 * Priority sections in TODO.md, ordered by urgency.
 */
const TODO_SECTION_PRIORITY = [
  'Alpha Blockers',
  'Active Technical Debt',
  'Backlog - Tier 1',
  'Backlog - Tier 2',
  'Known Issues',
];

/**
 * Scan docs/TODO.md for unchecked task items.
 *
 * @param {string} projectRoot
 * @returns {ScannedTask[]}
 */
export function scanTodoMd(projectRoot) {
  const todoPath = path.join(projectRoot, 'docs', 'TODO.md');
  if (!fs.existsSync(todoPath)) return [];

  let content;
  try {
    content = fs.readFileSync(todoPath, 'utf8');
  } catch {
    return [];
  }

  const tasks = [];
  const lines = content.split('\n');
  let currentSection = '';

  // Build section → tasks map
  const sectionTasks = new Map();

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    const sectionMatch = trimmed.match(/^##\s+(?:\d+\.\s+)?(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Unchecked items only
    const unchecked = trimmed.match(/^-\s+\[\s\]\s+(.+)/);
    if (unchecked && currentSection) {
      const taskText = unchecked[1]
        .replace(/\*\*/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim();
      if (taskText.length >= 5) {
        if (!sectionTasks.has(currentSection)) {
          sectionTasks.set(currentSection, []);
        }
        sectionTasks.get(currentSection).push({ text: taskText, section: currentSection });
      }
    }
  }

  // Flatten by priority order
  const ordered = [];
  for (const sectionName of TODO_SECTION_PRIORITY) {
    for (const [key, items] of sectionTasks) {
      if (key.includes(sectionName) || sectionName.includes(key.replace(/[^a-zA-Z ]/g, '').trim())) {
        ordered.push(...items);
      }
    }
  }
  // Remaining sections
  for (const [key, items] of sectionTasks) {
    const alreadyAdded = TODO_SECTION_PRIORITY.some(
      p => key.includes(p) || p.includes(key.replace(/[^a-zA-Z ]/g, '').trim())
    );
    if (!alreadyAdded) ordered.push(...items);
  }

  for (const item of ordered) {
    const slug = taskToSlug(item.text);
    const id = `todo-md:${slug}`;
    tasks.push(buildTask(id, item.text, 'todo-md', item.section));
  }

  return tasks;
}

// ── Source 3: GitHub Issues ─────────────────────────────────────────────────

/**
 * Scan GitHub issues via gh CLI.
 *
 * @param {string} projectRoot
 * @param {{ labels?: string[], limit?: number }} [opts={}]
 * @returns {ScannedTask[]}
 */
export function scanGitHubIssues(projectRoot, opts = {}) {
  if (!isGhAvailable() || !isGhAuthenticated()) return [];

  const issues = listIssues({
    cwd: projectRoot,
    state: 'open',
    labels: opts.labels || [],
    limit: opts.limit || 50,
  });

  return issues.map(issue => {
    const title = issue.title || `Issue #${issue.number}`;
    const id = `github:${issue.number}`;
    const body = issue.body || null;

    return buildTask(id, title, 'github-issue', `#${issue.number}`, body, issue.number);
  });
}

// ── Source 4: User-Provided Task ────────────────────────────────────────────

/**
 * Create a ScannedTask from freeform user input.
 *
 * @param {string} text
 * @returns {ScannedTask}
 */
export function createUserTask(text) {
  const slug = taskToSlug(text);
  return buildTask(`user:${slug}`, text, 'user-input', 'manual');
}

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * Deduplicate tasks by title similarity. Uses slug comparison.
 *
 * @param {ScannedTask[]} tasks
 * @returns {ScannedTask[]}
 */
export function deduplicateTasks(tasks) {
  const seen = new Map(); // slug → task
  const result = [];

  for (const task of tasks) {
    // Normalize slug for comparison
    const key = task.slug;
    if (seen.has(key)) continue;
    seen.set(key, task);
    result.push(task);
  }

  return result;
}

// ── Prioritization ──────────────────────────────────────────────────────────

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const COMPLEXITY_ORDER = { simple: 0, moderate: 1, complex: 2 };

/**
 * Sort tasks by priority (high first), then complexity (simple first).
 *
 * @param {ScannedTask[]} tasks
 * @returns {ScannedTask[]}
 */
export function prioritizeTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const pDiff = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    if (pDiff !== 0) return pDiff;
    return (COMPLEXITY_ORDER[a.complexity] ?? 1) - (COMPLEXITY_ORDER[b.complexity] ?? 1);
  });
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Scan all configured sources and return a deduplicated, prioritized task list.
 *
 * @param {string} projectRoot
 * @param {{ todoComments?: boolean, todoMd?: boolean, githubIssues?: boolean, githubLabels?: string[] }} [opts={}]
 * @returns {ScannedTask[]}
 */
export function scanAllSources(projectRoot, opts = {}) {
  const cfg = loadHydraConfig();
  const sources = cfg.tasks?.sources || {};

  const enableComments = opts.todoComments ?? sources.todoComments ?? true;
  const enableMd = opts.todoMd ?? sources.todoMd ?? true;
  const enableGh = opts.githubIssues ?? sources.githubIssues ?? true;

  const allTasks = [];

  if (enableComments) {
    allTasks.push(...scanTodoComments(projectRoot));
  }

  if (enableMd) {
    allTasks.push(...scanTodoMd(projectRoot));
  }

  if (enableGh) {
    allTasks.push(...scanGitHubIssues(projectRoot, { labels: opts.githubLabels }));
  }

  return prioritizeTasks(deduplicateTasks(allTasks));
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

if (isDirectRun) {
  (async () => {
    const projectRoot = process.argv[2] || process.cwd();

    // Initialize agent registry for classifyTask/bestAgentFor
    const { initAgentRegistry } = await import('./hydra-agents.mjs');
    initAgentRegistry();

    console.log(pc.bold('\nHydra Tasks Scanner\n'));

    const comments = scanTodoComments(projectRoot);
    const mdTasks = scanTodoMd(projectRoot);
    const ghTasks = scanGitHubIssues(projectRoot);

    console.log(`  Code comments: ${pc.cyan(String(comments.length))}`);
    console.log(`  TODO.md items: ${pc.cyan(String(mdTasks.length))}`);
    console.log(`  GitHub issues: ${pc.cyan(String(ghTasks.length))}`);

    const all = prioritizeTasks(deduplicateTasks([...comments, ...mdTasks, ...ghTasks]));
    console.log(`  Total (deduped): ${pc.bold(String(all.length))}\n`);

    for (const task of all.slice(0, 30)) {
      const prioColor = task.priority === 'high' ? pc.red : task.priority === 'low' ? pc.dim : pc.yellow;
      console.log(`  ${prioColor(task.priority.padEnd(6))} ${pc.dim(task.source.padEnd(13))} ${task.title}`);
      console.log(`  ${pc.dim('       ')} ${pc.dim(`[${task.taskType}] agent:${task.suggestedAgent} complexity:${task.complexity} ref:${task.sourceRef}`)}`);
    }

    if (all.length > 30) {
      console.log(pc.dim(`\n  ... and ${all.length - 30} more`));
    }

    console.log('');
  })().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
