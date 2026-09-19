#!/usr/bin/env node

/**
 * hydra-audit.mjs - Fan-out codebase audit across agents, assemble a punch list.
 *
 * Analysis only: no file edits, no branches, no commits.
 */

import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { loadHydraConfig } from './hydra-config.mjs';

// -- Args and config ---------------------------------------------------------

const rawArgv = process.argv.slice(2);
const args = Object.fromEntries(
  rawArgv
    .filter((a) => a.includes('='))
    .map((a) => {
      const [k, ...v] = a.split('=');
      return [k.trim().toLowerCase(), v.join('=').trim()];
    }),
);
const flags = new Set(rawArgv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').toLowerCase()));

const cfg = loadHydraConfig();
const auditCfg = cfg.audit && typeof cfg.audit === 'object' ? cfg.audit : {};

const ALL_CATEGORIES = ['dead-code', 'inconsistencies', 'architecture', 'security', 'tests', 'types'];
const DEFAULT_CATEGORIES = Array.isArray(auditCfg.categories) && auditCfg.categories.length > 0
  ? auditCfg.categories
  : ALL_CATEGORIES;

const PROJECT = resolve(args.project || process.cwd());
const CATEGORIES = parseCsv(args.categories || DEFAULT_CATEGORIES.join(','));
const AGENTS = parseCsv(args.agents || 'gemini,claude,codex');
const MAX_FILES = parsePositiveInt(args['max-files'], auditCfg.maxFiles, 200);
const TIMEOUT_MS = parsePositiveInt(args.timeout, auditCfg.timeout, 300000);
const REPORT_DIR = typeof auditCfg.reportDir === 'string' && auditCfg.reportDir.trim()
  ? auditCfg.reportDir
  : 'docs/audit';
const REPORT_PATH = args.report
  ? resolveReportPath(PROJECT, args.report)
  : join(PROJECT, REPORT_DIR, `${dateStr()}.md`);
const ECONOMY = flags.has('economy') || auditCfg.economy === true;
const VERBOSE = flags.has('verbose');
const RUN_ID = `${dateStr()}-${timeStr()}-${Math.random().toString(36).slice(2, 8)}`;

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parsePositiveInt(...values) {
  for (const value of values) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 1;
}

function resolveReportPath(projectPath, reportArg) {
  if (isAbsolute(reportArg)) {
    return reportArg;
  }
  return resolve(projectPath, reportArg);
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

function timeStr() {
  return new Date().toISOString().slice(11, 19).replace(/:/g, '-');
}

// -- Category definitions ----------------------------------------------------

const AUDIT_CATEGORIES = {
  'dead-code': {
    agent: 'gemini',
    label: 'Dead Code and Unused Exports',
    prompt: `Analyze this codebase for dead code and unused exports.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Exported functions/components/types that are never imported elsewhere
- Files that are never imported by any other file
- Unreachable code paths (after returns, impossible conditions)
- Commented-out code blocks that should be removed
- Unused dependencies in package.json

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": 42,
  "severity": "critical" | "major" | "minor",
  "category": "dead-code",
  "title": "Short description",
  "detail": "Why this matters and what to do",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  inconsistencies: {
    agent: 'gemini',
    label: 'Inconsistencies and Duplication',
    prompt: `Analyze this codebase for inconsistencies and duplication.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Naming convention inconsistencies (mixed camelCase/snake_case, inconsistent file naming)
- Duplicate logic that should be extracted into shared utilities
- Inconsistent patterns (e.g., some files use one approach, others use another for the same thing)
- Inconsistent error handling patterns
- Mixed import styles (default vs named, relative vs alias)

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "inconsistencies",
  "title": "Short description",
  "detail": "What's inconsistent and the recommended pattern to standardize on",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  architecture: {
    agent: 'claude',
    label: 'Architecture and Design',
    prompt: `Review this codebase architecture for design issues and improvement opportunities.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Circular dependencies or tangled module boundaries
- Components/modules doing too much (violation of single responsibility)
- Missing abstraction layers (e.g., direct DB calls from UI components)
- Poor separation of concerns
- State management issues (prop drilling, global state misuse)
- Missing or misplaced business logic
- API design issues (inconsistent endpoints, missing validation)

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "architecture",
  "title": "Short description",
  "detail": "What's wrong and a concrete suggestion for improvement",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  security: {
    agent: 'claude',
    label: 'Security Issues',
    prompt: `Perform a security review of this codebase.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Hardcoded secrets, API keys, or credentials
- SQL injection or NoSQL injection vectors
- XSS vulnerabilities (unsanitized user input in rendered output)
- Missing authentication/authorization checks on endpoints
- Insecure direct object references
- Missing rate limiting on sensitive endpoints
- Overly permissive CORS or RLS policies
- Sensitive data in logs or error messages
- Missing input validation
- Insecure defaults

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "security",
  "title": "Short description",
  "detail": "The vulnerability, its impact, and how to fix it",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  tests: {
    agent: 'codex',
    label: 'Test Coverage Gaps',
    prompt: `Analyze this codebase for test coverage gaps and testing issues.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Files with business logic that have no corresponding test file
- API routes/handlers with no integration tests
- Complex utility functions without unit tests
- Missing edge case coverage in existing tests
- Test files that are empty or have skipped/pending tests
- Missing error path testing
- Components with user interaction that lack interaction tests

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "tests",
  "title": "Short description",
  "detail": "What needs testing and what test cases to add",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  types: {
    agent: 'codex',
    label: 'Type Safety and Error Handling',
    prompt: `Analyze this codebase for type safety issues and missing error handling.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Use of 'any' type that should be properly typed
- Missing null/undefined checks
- Unsafe type assertions (as unknown as X)
- Missing error boundaries in React components
- try/catch blocks that swallow errors silently
- Promises without .catch() or missing await
- Missing return type annotations on exported functions
- Unhandled edge cases in switch statements (missing default)

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "types",
  "title": "Short description",
  "detail": "The type safety issue and how to fix it",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },
};

// -- File manifest builder ---------------------------------------------------

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.expo', 'dist', 'build', 'coverage',
  '.hydra', '.vercel', '.turbo', '__pycache__', '.cache', 'android', 'ios',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.sql', '.prisma',
  '.json', '.yaml', '.yml', '.toml',
]);

function getGitPrioritySets(projectPath) {
  const changed = new Set();
  const recent = new Set();

  const status = gitOutput(projectPath, ['status', '--porcelain']);
  for (const rawLine of status.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop() || filePath;
    }
    changed.add(filePath.replace(/\\/g, '/'));
  }

  const recentFiles = gitOutput(projectPath, ['log', '--name-only', '--pretty=format:', '-n', '50']);
  for (const line of recentFiles.split('\n')) {
    const normalized = line.trim().replace(/\\/g, '/');
    if (normalized) recent.add(normalized);
  }

  return { changed, recent };
}

function gitOutput(projectPath, gitArgs) {
  try {
    return execFileSync('git', ['-C', projectPath, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function buildManifest(projectPath, maxFiles) {
  const candidates = [];
  const scanLimit = Math.max(maxFiles * 6, 1000);

  function walk(dir, depth = 0) {
    if (depth > 10 || candidates.length >= scanLimit) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (candidates.length >= scanLimit) break;
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          walk(fullPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0) continue;

      const ext = entry.name.slice(dot);
      if (!CODE_EXTENSIONS.has(ext)) continue;

      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }

      candidates.push({
        path: relative(projectPath, fullPath).replace(/\\/g, '/'),
        size: st.size,
        ext,
      });
    }
  }

  walk(projectPath);

  const prioritySets = getGitPrioritySets(projectPath);
  const ranked = rankManifest(candidates, prioritySets);
  const selected = ranked.slice(0, maxFiles);

  const changedCount = selected.filter((f) => f.priority === 'changed').length;
  const recentCount = selected.filter((f) => f.priority === 'recent').length;

  return {
    files: selected,
    stats: {
      candidates: candidates.length,
      selected: selected.length,
      changed: changedCount,
      recent: recentCount,
    },
  };
}

function rankManifest(files, prioritySets) {
  return [...files]
    .map((file) => {
      const isChanged = prioritySets.changed.has(file.path);
      const isRecent = prioritySets.recent.has(file.path);
      const priority = isChanged ? 'changed' : isRecent ? 'recent' : 'normal';

      let score = 0;
      if (isChanged) score += 250;
      if (isRecent) score += 100;
      // Prefer smaller files very slightly for better context density.
      score -= Math.min(file.size / 500000, 5);

      return { ...file, priority, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });
}

function formatManifest(files) {
  const groups = {};
  for (const f of files) {
    const topDir = f.path.includes('/') ? f.path.split('/')[0] : '(root)';
    if (!groups[topDir]) groups[topDir] = [];
    groups[topDir].push(f);
  }

  let out = '';
  for (const [dir, entries] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
    out += `\n${dir}/\n`;
    for (const file of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      const hint = file.priority === 'changed' ? ' [changed]' : file.priority === 'recent' ? ' [recent]' : '';
      out += `  ${file.path}${hint}\n`;
    }
  }
  return out;
}

// -- Agent dispatch ----------------------------------------------------------

function getAgentCommand(agent, prompt, economy) {
  switch (agent) {
    case 'gemini':
      return { cmd: 'gemini', args: ['-p', prompt] };
    case 'claude':
      return {
        cmd: 'claude',
        args: ['-p', prompt, '--output-format', 'text', ...(economy ? ['--model', 'claude-haiku-4-5-20251001'] : [])],
      };
    case 'codex':
      return {
        cmd: 'codex',
        args: ['-p', prompt, '--full-context', ...(economy ? ['-m', 'o4-mini'] : [])],
      };
    default:
      throw new Error(`Unknown agent: ${agent}`);
  }
}

function dispatchToAgent(agent, prompt, projectPath, economy, timeoutMs) {
  return new Promise((resolvePromise) => {
    const { cmd, args } = getAgentCommand(agent, prompt, economy);
    const startedAt = Date.now();

    if (VERBOSE) {
      console.log(`  [${agent}] Dispatching (${cmd} -p ...)`);
    }

    const proc = spawn(cmd, args, {
      cwd: projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code, signal) => {
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (VERBOSE) {
        const status = code === 0 ? 'ok' : `exit=${code ?? 'null'} signal=${signal ?? 'none'}`;
        console.log(`  [${agent}] ${status} (${elapsedSec}s, ${stdout.length} chars)`);
      }
      resolvePromise({ agent, stdout, stderr, code, signal, elapsedSec });
    });

    proc.on('error', (err) => {
      resolvePromise({ agent, stdout: '', stderr: err.message, code: -1, signal: null, elapsedSec: '0.0' });
    });
  });
}

// -- Response parsing --------------------------------------------------------

const SEVERITIES = new Set(['critical', 'major', 'minor']);
const EFFORTS = new Set(['trivial', 'small', 'medium', 'large']);
const CATEGORY_ALIASES = {
  inconsistency: 'inconsistencies',
};

function parseFindings(agentResponse, fallbackCategory) {
  const text = String(agentResponse.stdout || '').trim();
  if (!text) return [];

  const candidates = [text];

  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }

  for (const rawCandidate of candidates) {
    try {
      const parsed = JSON.parse(rawCandidate);
      if (!Array.isArray(parsed)) continue;

      return parsed
        .map((item) => normalizeFinding(item, fallbackCategory))
        .filter(Boolean);
    } catch {
      // try next candidate
    }
  }

  if (VERBOSE) {
    console.log(`  [${agentResponse.agent}] Could not parse JSON response`);
    console.log(`  [${agentResponse.agent}] Raw (first 300 chars): ${text.slice(0, 300)}`);
  }

  return [];
}

function normalizeFinding(raw, fallbackCategory) {
  if (!raw || typeof raw !== 'object') return null;

  const severity = String(raw.severity || '').toLowerCase();
  const normalizedSeverity = SEVERITIES.has(severity) ? severity : 'minor';

  const effort = String(raw.effort || '').toLowerCase();
  const normalizedEffort = EFFORTS.has(effort) ? effort : 'medium';

  const categoryRaw = String(raw.category || fallbackCategory || '').toLowerCase();
  const normalizedCategory = CATEGORY_ALIASES[categoryRaw] || categoryRaw || fallbackCategory || 'uncategorized';

  const lineNumber = Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null;
  const file = typeof raw.file === 'string' ? raw.file.replace(/\\/g, '/') : '';
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Untitled finding';
  const detail = typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim() : 'No detail provided.';

  return {
    file,
    line: lineNumber,
    severity: normalizedSeverity,
    category: normalizedCategory,
    title,
    detail,
    effort: normalizedEffort,
  };
}

// -- Deduplication and scoring ----------------------------------------------

const SEVERITY_SCORE = { critical: 100, major: 50, minor: 10 };
const EFFORT_SCORE = { trivial: 4, small: 3, medium: 2, large: 1 };

function deduplicateFindings(findings) {
  const seen = new Map();

  for (const finding of findings) {
    const key = `${finding.category}::${finding.file}::${finding.title}`.toLowerCase();
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, finding);
      continue;
    }

    const currentScore = SEVERITY_SCORE[finding.severity] || 0;
    const existingScore = SEVERITY_SCORE[existing.severity] || 0;
    if (currentScore > existingScore) {
      seen.set(key, finding);
    }
  }

  return Array.from(seen.values());
}

function scoreAndSort(findings) {
  return findings
    .map((finding) => ({
      ...finding,
      _score: (SEVERITY_SCORE[finding.severity] || 10) * (EFFORT_SCORE[finding.effort] || 2),
    }))
    .sort((a, b) => b._score - a._score);
}

// -- Report generation -------------------------------------------------------

function generateReport(findings, manifest, reportMeta) {
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16);

  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const majorCount = findings.filter((f) => f.severity === 'major').length;
  const minorCount = findings.filter((f) => f.severity === 'minor').length;

  const byCategory = {};
  for (const finding of findings) {
    const category = finding.category || 'uncategorized';
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(finding);
  }

  let md = `# Audit Report: ${reportMeta.projectName}

**Run ID:** ${reportMeta.runId}
**Date:** ${date} ${time}
**Agents:** ${reportMeta.agents.join(', ')}
**Categories:** ${reportMeta.categories.join(', ')}
**Files scanned:** ${manifest.length}
**Manifest bias:** changed ${reportMeta.manifestStats.changed}, recent ${reportMeta.manifestStats.recent}
**Findings:** ${findings.length} (${criticalCount} critical, ${majorCount} major, ${minorCount} minor)
**Time:** ${reportMeta.elapsedSec}s

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | ${criticalCount} |
| Major    | ${majorCount} |
| Minor    | ${minorCount} |
| **Total** | **${findings.length}** |

---

## Prioritized Punch List

> Sorted by impact x ease-of-fix. Tackle top-down.

`;

  for (let i = 0; i < findings.length; i += 1) {
    const finding = findings[i];
    const severityIcon = finding.severity === 'critical' ? '[CRIT]' : finding.severity === 'major' ? '[MAJOR]' : '[MINOR]';
    const effortTag = finding.effort ? ` \`${finding.effort}\`` : '';
    const fileRef = finding.file ? ` - \`${finding.file}\`${finding.line ? `:${finding.line}` : ''}` : '';

    md += `${i + 1}. ${severityIcon} **${finding.title}**${effortTag}${fileRef}\n`;
    md += `   ${finding.detail}\n\n`;
  }

  md += `---\n\n## By Category\n\n`;

  for (const [category, categoryFindings] of Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))) {
    const categoryLabel = AUDIT_CATEGORIES[category]?.label || category;
    const categoryAgent = AUDIT_CATEGORIES[category]?.agent || 'unknown';
    md += `### ${categoryLabel} (${categoryAgent})\n\n`;

    for (const finding of categoryFindings) {
      md += `- **${finding.title}** \`${finding.severity}\` \`${finding.effort}\`\n`;
      if (finding.file) md += `  File: \`${finding.file}\`${finding.line ? `:${finding.line}` : ''}\n`;
      md += `  ${finding.detail}\n\n`;
    }
  }

  const quickWins = findings.filter(
    (f) => (f.effort === 'trivial' || f.effort === 'small') && (f.severity === 'critical' || f.severity === 'major'),
  );

  if (quickWins.length > 0) {
    md += `---\n\n## Quick Wins\n\n`;
    md += `> High-impact, low-effort items to tackle first.\n\n`;
    for (const finding of quickWins) {
      md += `- **${finding.title}** - \`${finding.file || 'project-wide'}\` (${finding.severity}, ${finding.effort})\n`;
    }
    md += '\n';
  }

  md += `---\n\n*Generated by Hydra Audit (${reportMeta.runId}) on ${date} at ${time}. Analysis only; no code was modified.*\n`;

  return md;
}

// -- Main -------------------------------------------------------------------

async function main() {
  const knownAgents = new Set(['gemini', 'claude', 'codex']);
  const activeAgents = AGENTS.filter((agent) => knownAgents.has(agent));
  const unknownAgents = AGENTS.filter((agent) => !knownAgents.has(agent));

  const requestedCategories = CATEGORIES.includes('all') ? ALL_CATEGORIES : CATEGORIES;
  const unknownCategories = requestedCategories.filter((category) => !AUDIT_CATEGORIES[category]);
  const validCategories = requestedCategories.filter((category) => AUDIT_CATEGORIES[category]);

  const runnableCategories = validCategories.filter((category) => {
    const assignedAgent = AUDIT_CATEGORIES[category].agent;
    return activeAgents.includes(assignedAgent);
  });

  console.log('');
  console.log('=== Hydra Audit ===');
  console.log(`  Run ID:     ${RUN_ID}`);
  console.log(`  Project:    ${PROJECT}`);
  console.log(`  Agents:     ${activeAgents.join(', ') || '(none)'}`);
  console.log(`  Categories: ${runnableCategories.join(', ') || '(none)'}`);
  console.log(`  Max files:  ${MAX_FILES}`);
  if (ECONOMY) {
    console.log('  Models:     economy tier');
  }
  console.log('');

  if (unknownAgents.length > 0) {
    console.log(`! Ignoring unknown agents: ${unknownAgents.join(', ')}`);
  }
  if (unknownCategories.length > 0) {
    console.log(`! Ignoring unknown categories: ${unknownCategories.join(', ')}`);
  }

  console.log('1) Building file manifest...');
  const { files: manifest, stats: manifestStats } = buildManifest(PROJECT, MAX_FILES);
  console.log(`   Indexed ${manifest.length} files (from ${manifestStats.candidates} candidates)`);
  if (manifestStats.changed > 0 || manifestStats.recent > 0) {
    console.log(`   Prioritized changed=${manifestStats.changed}, recent=${manifestStats.recent}`);
  }

  if (manifest.length === 0) {
    console.log('   No code files found. Check project path.');
    process.exit(1);
  }

  if (runnableCategories.length === 0) {
    console.log('   No runnable categories after filters; generating empty report.');
  }

  const manifestText = formatManifest(manifest);
  const projectName = basename(PROJECT);

  const startedAt = Date.now();
  const allFindings = [];

  if (runnableCategories.length > 0) {
    console.log('');
    console.log('2) Dispatching audit categories:');
    for (const category of runnableCategories) {
      const def = AUDIT_CATEGORIES[category];
      console.log(`   - ${def.label} -> ${def.agent}`);
    }
    console.log('');

    const categoriesByAgent = {};
    for (const category of runnableCategories) {
      const agent = AUDIT_CATEGORIES[category].agent;
      if (!categoriesByAgent[agent]) categoriesByAgent[agent] = [];
      categoriesByAgent[agent].push(category);
    }

    const agentPromises = Object.entries(categoriesByAgent).map(async ([agent, categories]) => {
      const findings = [];
      for (const category of categories) {
        const def = AUDIT_CATEGORIES[category];
        const prompt = def.prompt
          .replace('{{manifest}}', manifestText)
          .replace('{{projectName}}', projectName);

        console.log(`  [${agent}] ${def.label}...`);
        const result = await dispatchToAgent(agent, prompt, PROJECT, ECONOMY, TIMEOUT_MS);
        if (result.code !== 0 && VERBOSE && result.stderr) {
          console.log(`  [${agent}] stderr: ${result.stderr.slice(0, 300)}`);
        }

        const parsed = parseFindings(result, category);
        console.log(`  [${agent}] ${def.label}: ${parsed.length} findings`);
        findings.push(...parsed);
      }
      return findings;
    });

    const nested = await Promise.all(agentPromises);
    for (const findings of nested) {
      allFindings.push(...findings);
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);

  console.log('');
  console.log(`3) Processing ${allFindings.length} raw findings...`);
  const deduped = deduplicateFindings(allFindings);
  const scored = scoreAndSort(deduped);
  console.log(`   ${scored.length} unique findings after deduplication`);

  console.log('');
  console.log('4) Generating report...');
  const report = generateReport(scored, manifest, {
    runId: RUN_ID,
    projectName,
    categories: runnableCategories,
    agents: activeAgents,
    elapsedSec,
    manifestStats,
  });

  const reportDir = dirname(REPORT_PATH);
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(`   Report saved: ${REPORT_PATH}`);

  const critical = scored.filter((f) => f.severity === 'critical').length;
  const major = scored.filter((f) => f.severity === 'major').length;
  const quickWins = scored.filter(
    (f) => (f.effort === 'trivial' || f.effort === 'small') && (f.severity === 'critical' || f.severity === 'major'),
  ).length;

  console.log('');
  console.log('=== Summary ===');
  console.log(`  Run ID:      ${RUN_ID}`);
  console.log(`  Critical:    ${critical}`);
  console.log(`  Major:       ${major}`);
  console.log(`  Quick wins:  ${quickWins}`);
  console.log(`  Time:        ${elapsedSec}s`);
  console.log('');
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
