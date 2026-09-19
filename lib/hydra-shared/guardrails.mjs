/**
 * Shared Guardrails — Safety prompt builder, violation scanner, and branch checks
 * used by both nightly and evolve pipelines.
 *
 * Each pipeline passes its own config (runner name, protected files, extra rules).
 */

import fs from 'fs';
import path from 'path';
import { spawnSyncCapture } from '../hydra-proc.mjs';

/**
 * Verify the current git branch matches the expected branch.
 * @param {string} projectRoot
 * @param {string} expectedBranch
 * @returns {{ ok: boolean, currentBranch: string }}
 */
export function verifyBranch(projectRoot, expectedBranch) {
  const result = spawnSyncCapture('git', ['branch', '--show-current'], { cwd: projectRoot, encoding: 'utf8', timeout: 5_000 });
  const current = (result.stdout || '').trim();
  return { ok: current === expectedBranch, currentBranch: current };
}

/**
 * Check if working tree is clean.
 * @param {string} projectRoot
 * @returns {boolean}
 */
export function isCleanWorkingTree(projectRoot) {
  const result = spawnSyncCapture('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8', timeout: 5_000 });
  return !(result.stdout || '').trim();
}

/**
 * Build the safety rules block injected into autonomous agent prompts.
 *
 * @param {string} branchName - Current branch name
 * @param {object} opts
 * @param {string} opts.runner - Runner name (e.g., 'nightly runner', 'evolve runner')
 * @param {string} opts.reportName - Report name (e.g., 'morning report', 'session report')
 * @param {Set<string>} opts.protectedFiles - Set of protected file paths
 * @param {string[]} opts.blockedCommands - Array of blocked commands
 * @param {string[]} [opts.extraRules] - Additional scope rules
 * @param {{ pipeline: string, agent?: string }} [opts.attribution] - Commit attribution metadata
 * @returns {string}
 */
export function buildSafetyPrompt(branchName, {
  runner,
  reportName,
  protectedFiles,
  blockedCommands,
  extraRules = [],
  attribution,
}) {
  const extraSection = extraRules.length > 0
    ? '\n' + extraRules.map(r => `- ${r}`).join('\n')
    : '';

  let attributionSection = '';
  if (attribution) {
    const trailerLines = [`Originated-By: ${attribution.pipeline}`];
    if (attribution.agent) trailerLines.push(`Executed-By: ${attribution.agent}`);
    attributionSection = `

### Commit Attribution
- Include these git trailers at the end of every commit message:
${trailerLines.map(t => `  ${t}`).join('\n')}
- Trailers go after a blank line at the end of the commit message body`;
  }

  return `## SAFETY RULES (NON-NEGOTIABLE)
These rules are enforced by the ${runner}. Violations are flagged in the ${reportName}.

### Branch Isolation
- You are on branch: \`${branchName}\`
- ONLY commit to this branch
- NEVER run: git push, git checkout dev, git checkout staging, git checkout main
- NEVER run: git merge into dev/staging/main, git rebase

### Protected Files — DO NOT MODIFY
${[...protectedFiles].map(f => `- \`${f}\``).join('\n')}

### Blocked Commands — NEVER EXECUTE
${blockedCommands.map(c => `- \`${c}\``).join('\n')}

### Scope
- Focus ONLY on your assigned task
- Do NOT fix unrelated issues (note them in your commit message instead)
- Do NOT add unrelated documentation, changelog entries, or version bumps
- Do NOT install new npm packages without clear necessity
- Before committing, verify that README.md, CLAUDE.md, and docs/ARCHITECTURE.md reflect your changes — update any that are out of date${extraSection}${attributionSection}`;
}

// ── Secrets Detection ────────────────────────────────────────────────────────

const SECRETS_FILE_PATTERNS = [
  /\.env$/,
  /\.env\./,
  /\.key$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /credentials\./i,
  /secrets?\./i,
  /api[_-]?key/i,
  /auth[_-]?token/i,
  /\.keystore$/,
];

const SECRETS_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/,
  /(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|access[_-]?token)[\s:=]+['"]?[a-zA-Z0-9_\-/.]{20,}/i,
  /(?:password|passwd|pwd)[\s:=]+['"]?[^\s'"]{8,}/i,
  /ghp_[a-zA-Z0-9]{36}/,           // GitHub PAT
  /sk-[a-zA-Z0-9]{20,}/,           // OpenAI key
  /AKIA[0-9A-Z]{16}/,              // AWS access key
  /AIza[0-9A-Za-z_-]{35}/,         // Google API key
];

/**
 * Scan changed files for potential secrets (filenames and content).
 * @param {string} projectRoot
 * @param {string[]} changedFiles
 * @returns {Array<{type: string, detail: string, severity: string}>}
 */
export function scanForSecrets(projectRoot, changedFiles) {
  const violations = [];

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');

    // Filename check
    for (const pattern of SECRETS_FILE_PATTERNS) {
      if (pattern.test(normalized)) {
        violations.push({
          type: 'secrets_filename',
          detail: `Potential secrets file: ${file}`,
          severity: 'critical',
        });
        break;
      }
    }

    // Content check (first 2KB for performance)
    try {
      const fullPath = path.join(projectRoot, file);
      const content = fs.readFileSync(fullPath, 'utf8').slice(0, 2048);
      for (const pattern of SECRETS_CONTENT_PATTERNS) {
        if (pattern.test(content)) {
          violations.push({
            type: 'secrets_content',
            detail: `Potential secret detected in: ${file}`,
            severity: 'critical',
          });
          break;
        }
      }
    } catch {
      // Skip binary or inaccessible files
    }
  }

  return violations;
}

/**
 * Check total diff size (insertions + deletions) against a limit.
 * @param {string} projectRoot
 * @param {string} branchName
 * @param {object} opts
 * @param {string} [opts.baseBranch='dev']
 * @param {number} [opts.maxDiffLines=10000]
 * @returns {{type: string, detail: string, severity: string, totalLines: number}|null}
 */
export function checkDiffSize(projectRoot, branchName, opts = {}) {
  const { baseBranch = 'dev', maxDiffLines = 10000 } = opts;

  const result = spawnSyncCapture('git', ['diff', '--stat', `${baseBranch}...${branchName}`], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 });

  if (result.status !== 0 || !result.stdout) return null;

  const lines = result.stdout.trim().split('\n');
  const summary = lines[lines.length - 1] || '';
  const match = summary.match(/(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/);
  if (!match) return null;

  const totalLines = parseInt(match[1], 10) + parseInt(match[2], 10);
  if (totalLines > maxDiffLines) {
    return {
      type: 'diff_too_large',
      detail: `Diff too large: ${totalLines} lines changed (max: ${maxDiffLines})`,
      severity: 'warning',
      totalLines,
    };
  }

  return null;
}

/**
 * Scan a branch's diff against the base branch for guardrail violations.
 *
 * @param {string} projectRoot
 * @param {string} branchName
 * @param {object} opts
 * @param {string} [opts.baseBranch='dev'] - Base branch to diff against
 * @param {Set<string>} opts.protectedFiles - Set of protected file paths
 * @param {RegExp[]} opts.protectedPatterns - Array of protected path patterns
 * @param {boolean} [opts.checkDeletedTests=false] - Whether to flag deleted test files
 * @returns {Array<{type: string, detail: string, severity: string}>}
 */
export function scanBranchViolations(projectRoot, branchName, {
  baseBranch = 'dev',
  protectedFiles,
  protectedPatterns,
  checkDeletedTests = false,
  secretsScan = false,
  maxDiffLines = 0,
}) {
  const violations = [];

  const diffResult = spawnSyncCapture('git', ['diff', '--name-only', `${baseBranch}...${branchName}`], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 });

  if (diffResult.status !== 0 || !diffResult.stdout) {
    return violations;
  }

  const changedFiles = diffResult.stdout.trim().split('\n').filter(Boolean);

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');

    if (protectedFiles.has(normalized)) {
      violations.push({
        type: 'protected_file',
        detail: `Modified protected file: ${file}`,
        severity: 'critical',
      });
    }

    for (const pattern of protectedPatterns) {
      if (pattern.test(normalized)) {
        violations.push({
          type: 'protected_pattern',
          detail: `Modified file matching protected pattern: ${file}`,
          severity: 'warning',
        });
        break;
      }
    }
  }

  if (checkDeletedTests) {
    const deletedResult = spawnSyncCapture('git', ['diff', '--name-only', '--diff-filter=D', `${baseBranch}...${branchName}`], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 });

    if (deletedResult.status === 0 && deletedResult.stdout) {
      const deletedFiles = deletedResult.stdout.trim().split('\n').filter(Boolean);
      for (const file of deletedFiles) {
        if (/\.test\.|\.spec\.|__tests__/.test(file)) {
          violations.push({
            type: 'deleted_test',
            detail: `Deleted test file: ${file}`,
            severity: 'critical',
          });
        }
      }
    }
  }

  // Secrets scan
  if (secretsScan && changedFiles.length > 0) {
    const secretViolations = scanForSecrets(projectRoot, changedFiles);
    violations.push(...secretViolations);
  }

  // Diff size check
  if (maxDiffLines > 0) {
    const diffViolation = checkDiffSize(projectRoot, branchName, { baseBranch, maxDiffLines });
    if (diffViolation) violations.push(diffViolation);
  }

  return violations;
}
