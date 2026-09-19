/**
 * Hydra GitHub Integration — gh CLI wrapper for PR management and repo operations.
 *
 * Shells out to `gh` CLI (same pattern as git() in git-ops.mjs).
 * 30s timeout for network operations.
 */

import fs from 'fs';
import path from 'path';
import { loadHydraConfig } from './hydra-config.mjs';
import { pushBranch, getCurrentBranch, getBranchLog } from './hydra-shared/git-ops.mjs';
import { spawnSyncCapture } from './hydra-proc.mjs';

/**
 * Run a gh CLI command synchronously.
 * @param {string[]} args
 * @param {string} [cwd=process.cwd()]
 * @returns {{ status: number|null, stdout: string, stderr: string, error: Error|null }}
 */
export function gh(args, cwd = process.cwd()) {
  const r = spawnSyncCapture('gh', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    shell: false,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error, signal: r.signal };
}

/**
 * Check if `gh` CLI is installed and accessible.
 * @returns {boolean}
 */
export function isGhAvailable() {
  try {
    const r = gh(['--version']);
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if `gh` is authenticated with GitHub.
 * @returns {boolean}
 */
export function isGhAuthenticated() {
  try {
    const r = gh(['auth', 'status']);
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detect the current GitHub repository.
 * @param {string} [cwd=process.cwd()]
 * @returns {{ owner: string, repo: string, defaultBranch: string } | null}
 */
export function detectRepo(cwd = process.cwd()) {
  const r = gh(['repo', 'view', '--json', 'owner,name,defaultBranchRef'], cwd);
  if (r.status !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    return {
      owner: data.owner?.login || data.owner || '',
      repo: data.name || '',
      defaultBranch: data.defaultBranchRef?.name || 'main',
    };
  } catch {
    return null;
  }
}

/**
 * Create a pull request.
 * @param {{ cwd?: string, head: string, base: string, title: string, body?: string, draft?: boolean, labels?: string[], reviewers?: string[] }} opts
 * @returns {{ ok: boolean, url?: string, number?: number, error?: string }}
 */
export function createPR({ cwd = process.cwd(), head, base, title, body = '', draft = false, labels = [], reviewers = [] }) {
  const args = ['pr', 'create', '--head', head, '--base', base, '--title', title, '--body', body || ''];
  if (draft) args.push('--draft');
  for (const l of labels) args.push('--label', l);
  for (const r of reviewers) args.push('--reviewer', r);

  const result = gh(args, cwd);
  if (result.status === 0) {
    const url = (result.stdout || '').trim();
    const numMatch = url.match(/\/pull\/(\d+)/);
    return { ok: true, url, number: numMatch ? parseInt(numMatch[1], 10) : undefined };
  }
  return { ok: false, error: (result.stderr || result.stdout || '').trim() };
}

/**
 * List pull requests.
 * @param {{ cwd?: string, state?: string, base?: string, head?: string }} [opts={}]
 * @returns {Array<{ number: number, title: string, headRefName: string, author: string, state: string }>}
 */
export function listPRs({ cwd = process.cwd(), state = 'open', base, head } = {}) {
  const args = ['pr', 'list', '--json', 'number,title,headRefName,author,state', '--state', state];
  if (base) args.push('--base', base);
  if (head) args.push('--head', head);

  const r = gh(args, cwd);
  if (r.status !== 0) return [];
  try {
    const data = JSON.parse(r.stdout);
    return data.map(pr => ({
      number: pr.number,
      title: pr.title,
      headRefName: pr.headRefName,
      author: pr.author?.login || pr.author || '',
      state: pr.state,
    }));
  } catch {
    return [];
  }
}

/**
 * Get details for a specific pull request.
 * @param {{ cwd?: string, ref: string|number }} opts
 * @returns {object|null}
 */
export function getPR({ cwd = process.cwd(), ref }) {
  const r = gh(['pr', 'view', String(ref), '--json', 'number,title,state,headRefName,baseRefName,url,additions,deletions,reviewRequests,author,body'], cwd);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Merge a pull request.
 * @param {{ cwd?: string, ref: string|number, method?: 'merge'|'squash'|'rebase', deleteAfter?: boolean }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function mergePR({ cwd = process.cwd(), ref, method = 'merge', deleteAfter = true }) {
  const args = ['pr', 'merge', String(ref), `--${method}`];
  if (deleteAfter) args.push('--delete-branch');
  const r = gh(args, cwd);
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || '').trim() };
}

/**
 * Close a pull request without merging.
 * @param {{ cwd?: string, ref: string|number }} opts
 * @returns {{ ok: boolean, error?: string }}
 */
export function closePR({ cwd = process.cwd(), ref }) {
  const r = gh(['pr', 'close', String(ref)], cwd);
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || '').trim() };
}

/**
 * List GitHub issues.
 * @param {{ cwd?: string, state?: string, labels?: string[], limit?: number }} [opts={}]
 * @returns {Array<{ number: number, title: string, body: string, labels: string[], assignees: string[], state: string }>}
 */
export function listIssues({ cwd = process.cwd(), state = 'open', labels = [], limit = 25 } = {}) {
  const args = ['issue', 'list', '--json', 'number,title,body,labels,assignees,state',
                '--state', state, '--limit', String(limit)];
  for (const l of labels) args.push('--label', l);
  const r = gh(args, cwd);
  if (r.status !== 0) return [];
  try { return JSON.parse(r.stdout); } catch { return []; }
}

/**
 * Get the github config section with defaults.
 * @returns {{ enabled: boolean, defaultBase: string, draft: boolean, labels: string[], reviewers: string[], prBodyFooter: string }}
 */
export function getGitHubConfig() {
  const cfg = loadHydraConfig();
  return {
    enabled: false,
    defaultBase: '',
    draft: false,
    labels: [],
    reviewers: [],
    prBodyFooter: '',
    ...cfg.github,
  };
}

// ── GitOps Safety ───────────────────────────────────────────────────────────

/**
 * Detect a PR template file in the repository.
 * Checks standard GitHub template locations.
 * @param {string} projectRoot
 * @returns {string|null} Template content or null
 */
function detectPRTemplate(projectRoot) {
  const candidates = [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'docs/pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
  ];
  for (const rel of candidates) {
    const full = path.join(projectRoot, rel);
    try {
      if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
    } catch { /* skip */ }
  }
  return null;
}

/**
 * Auto-detect labels based on changed files.
 * @param {string[]} changedFiles - List of changed file paths
 * @param {Record<string, string[]>} labelConfig - Label → pattern map from config
 * @returns {string[]} Labels to apply
 */
function detectAutoLabels(changedFiles, labelConfig) {
  if (!labelConfig || !changedFiles?.length) return [];
  const labels = new Set();
  for (const [label, patterns] of Object.entries(labelConfig)) {
    for (const pat of patterns) {
      const regex = new RegExp(pat);
      if (changedFiles.some(f => regex.test(f))) {
        labels.add(label);
        break;
      }
    }
  }
  return [...labels];
}

/**
 * Verify that required CI checks have passed on a PR.
 * @param {{ cwd?: string, ref: string|number }} opts
 * @returns {{ ok: boolean, pending: string[], failed: string[] }}
 */
export function verifyRequiredChecks({ cwd = process.cwd(), ref }) {
  const cfg = loadHydraConfig();
  const required = cfg.github?.requiredChecks || [];
  if (required.length === 0) return { ok: true, pending: [], failed: [] };

  const r = gh(['pr', 'checks', String(ref), '--json', 'name,state'], cwd);
  if (r.status !== 0) return { ok: false, pending: [], failed: ['(could not fetch checks)'] };

  let checks;
  try { checks = JSON.parse(r.stdout); } catch { return { ok: false, pending: [], failed: ['(parse error)'] }; }

  const pending = [];
  const failed = [];
  for (const name of required) {
    const check = checks.find(c => c.name === name);
    if (!check) { pending.push(name); continue; }
    if (check.state === 'FAILURE' || check.state === 'ERROR') failed.push(name);
    else if (check.state !== 'SUCCESS') pending.push(name);
  }
  return { ok: failed.length === 0 && pending.length === 0, pending, failed };
}

/**
 * Push a branch to origin and create a PR. Auto-generates title/body from branch name and commit log.
 * Applies config defaults (labels, reviewers, draft, footer).
 *
 * @param {{ cwd?: string, branch?: string, baseBranch?: string, title?: string, body?: string, draft?: boolean }} [opts={}]
 * @returns {{ ok: boolean, url?: string, number?: number, error?: string }}
 */
export function pushBranchAndCreatePR(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const branch = opts.branch || getCurrentBranch(cwd);
  const ghCfg = getGitHubConfig();

  // Determine base branch
  let baseBranch = opts.baseBranch || ghCfg.defaultBase;
  if (!baseBranch) {
    const repo = detectRepo(cwd);
    baseBranch = repo?.defaultBranch || 'main';
  }

  // Push the branch
  const pushResult = pushBranch(cwd, branch, { setUpstream: true });
  if (!pushResult.ok) {
    return { ok: false, error: `Push failed: ${pushResult.stderr}` };
  }

  // Auto-generate title from branch name if not provided
  const title = opts.title || branch
    .replace(/^(evolve|nightly)\//, '')
    .replace(/[/_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || branch;

  // Auto-generate body from commit log if not provided
  let body = opts.body || '';
  if (!body) {
    // Try injecting PR template first
    const template = detectPRTemplate(cwd);
    if (template) {
      body = template;
    }
    const log = getBranchLog(cwd, branch, baseBranch);
    if (log) {
      const commitSection = `## Commits\n\n${log.split('\n').map(l => `- ${l}`).join('\n')}`;
      body = body ? `${body}\n\n${commitSection}` : commitSection;
    }
  }

  // Append footer from config
  if (ghCfg.prBodyFooter) {
    body = body ? `${body}\n\n---\n${ghCfg.prBodyFooter}` : ghCfg.prBodyFooter;
  }

  // Auto-detect labels from changed files
  let labels = [...(ghCfg.labels || [])];
  const autolabelCfg = loadHydraConfig().github?.autolabel;
  if (autolabelCfg) {
    // Get changed files via git diff (works before PR exists)
    let changedFiles = [];
    const gitDiff = spawn.sync('git', ['diff', '--name-only', `${baseBranch}...${branch}`], { cwd, encoding: 'utf8', timeout: 10_000 });
    if (gitDiff.status === 0 && gitDiff.stdout) {
      changedFiles = gitDiff.stdout.trim().split('\n').filter(Boolean);
    }
    const autoLabels = detectAutoLabels(changedFiles, autolabelCfg);
    for (const l of autoLabels) {
      if (!labels.includes(l)) labels.push(l);
    }
  }

  const draft = opts.draft !== undefined ? opts.draft : ghCfg.draft;

  return createPR({
    cwd,
    head: branch,
    base: baseBranch,
    title,
    body,
    draft,
    labels,
    reviewers: ghCfg.reviewers,
  });
}
